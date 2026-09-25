import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { authHeaders, debugLog, redactSecrets, requestJson } from "./http.js";
import { domainFilters } from "./sources.js";

const DEFAULT_TAVILY_API_URL = "https://api.tavily.com";
const DEFAULT_TAVILY_PROXY_TIMEOUT_MS = 12_000;
const DEFAULT_TAVILY_RR_PATH = path.join(homedir(), ".cache", "grok-search", "tavily-rr.json");
const TAVILY_SEARCH_TIMEOUT_MS = 90_000;
const TAVILY_EXTRACT_TIMEOUT_MS = 60_000;
const QUOTA_OR_KEY_MESSAGE =
  /insufficient[_-]?quota|quota[_-]?exhausted|credits?[_-]?exhausted|insufficient[_-]?credits?|payment[_-]?required|invalid.?api.?key|unauthorized|api.?key.*(invalid|expired|revoked)|额度|余额|计费/i;

export function allTavilyKeys(config) {
  if (Array.isArray(config?.tavilyApiKeys) && config.tavilyApiKeys.length) {
    return config.tavilyApiKeys.map((key) => String(key || "").trim()).filter(Boolean);
  }
  if (typeof config?.tavilyApiKey === "string" && config.tavilyApiKey.trim()) {
    return [config.tavilyApiKey.trim()];
  }
  return [];
}

export function hasTavilyProxy(config) {
  return Boolean(
    typeof config?.tavilyProxyUrl === "string" &&
      config.tavilyProxyUrl.trim() &&
      typeof config?.tavilyProxyKey === "string" &&
      config.tavilyProxyKey.trim()
  );
}

export function hasTavilyApiKey(config) {
  return hasTavilyProxy(config) || allTavilyKeys(config).length > 0;
}

function tavilyOfficialApiUrl(config) {
  const url = typeof config?.tavilyApiUrl === "string" ? config.tavilyApiUrl.trim() : "";
  return (url || DEFAULT_TAVILY_API_URL).replace(/\/+$/, "");
}

function tavilyProxyTarget(config) {
  if (!hasTavilyProxy(config)) return null;
  return {
    apiUrl: config.tavilyProxyUrl.trim().replace(/\/+$/, ""),
    apiKey: config.tavilyProxyKey.trim(),
  };
}

export function tavilyProxyTimeoutMs(config) {
  const n = config?.tavilyProxyTimeoutMs;
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_TAVILY_PROXY_TIMEOUT_MS;
}

export function tavilyRoundRobinPath(config) {
  if (typeof config?.tavilyRoundRobinPath === "string" && config.tavilyRoundRobinPath.trim()) {
    return config.tavilyRoundRobinPath.trim();
  }
  return DEFAULT_TAVILY_RR_PATH;
}

/** Read the persistent next index; returns 0 when the file is missing or corrupt. */
export function loadTavilyRoundRobinIndex(keyCount, config) {
  if (!Number.isFinite(keyCount) || keyCount <= 0) return 0;
  try {
    const data = JSON.parse(readFileSync(tavilyRoundRobinPath(config), "utf8"));
    const n = Number(data?.nextIndex);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.trunc(n) % keyCount;
  } catch {
    return 0;
  }
}

/** Persist the next index for later CLI processes. Best-effort. */
export function saveTavilyRoundRobinIndex(nextIndex, config) {
  try {
    const filePath = tavilyRoundRobinPath(config);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = `${JSON.stringify({ nextIndex: Math.max(0, Math.trunc(nextIndex)), updatedAt: new Date().toISOString() })}\n`;
    writeFileSync(filePath, payload, { encoding: "utf8", mode: 0o600 });
  } catch {
    // RR degrades to always-start-at-0.
  }
}

/**
 * Claim the next official-key slot. The cursor advances immediately so the next CLI run
 * starts on a different key. A proxy hit must not call this.
 */
export function nextTavilyApiKey(config) {
  const keys = allTavilyKeys(config);
  if (!keys.length) return null;
  const index = loadTavilyRoundRobinIndex(keys.length, config);
  saveTavilyRoundRobinIndex(index + 1, config);
  return { key: keys[index], index, total: keys.length };
}

function parseHttpStatusFromMessage(message) {
  const match = String(message || "").match(/\bHTTP\s+(\d{3})\b/i);
  if (!match) return undefined;
  const status = Number.parseInt(match[1], 10);
  return Number.isFinite(status) ? status : undefined;
}

export function isTavilyKeyExhaustedError(error) {
  const msg = String(error?.message || error || "");
  const status = error?.status ?? parseHttpStatusFromMessage(msg);
  if (status === 401 || status === 402) return true;
  if (status === 403) return QUOTA_OR_KEY_MESSAGE.test(msg);
  // 429 is a key failure only when the body says the quota is gone. A bare rate limit
  // is transient: rotating the pool would spend every remaining key on the same request.
  if (status === 429) return /quota|credit|balance|billing|额度|余额|计费/i.test(msg);
  return QUOTA_OR_KEY_MESSAGE.test(msg);
}

function tavilyTargetMeta(backend, index, keyTotal, tried, extra = {}) {
  return {
    tavily_backend: backend,
    tavily_key_index: index,
    tavily_key_total: keyTotal,
    tavily_keys_tried: tried,
    ...(extra.tavily_proxy_tried ? { tavily_proxy_tried: true } : {}),
    ...(extra.tavily_proxy_error ? { tavily_proxy_error: extra.tavily_proxy_error } : {}),
  };
}

function tavilyRequestOptions(config, target, officialTimeoutMs) {
  const proxy = target?.backend === "proxy";
  return {
    timeoutMs: proxy ? tavilyProxyTimeoutMs(config) : officialTimeoutMs,
    config,
    retry: !proxy,
    retryOnTimeout: !proxy,
  };
}

/**
 * Run fn(apiKey, index, total, target). A configured proxy is tried first, with a short
 * timeout and no retry. HTTP errors, thrown errors, and a caller-returned `ok: false`
 * (empty proxy search/map) fall through to the official key pool. Official keys start at
 * the persistent RR index and rotate only on quota or auth failure.
 */
export async function withTavilyApiKey(config, fn) {
  const keys = allTavilyKeys(config);
  const proxy = tavilyProxyTarget(config);
  if (!proxy && !keys.length) {
    return { skipped: true, error: "TAVILY_API_KEY 未配置" };
  }

  let lastError = "Tavily request failed";
  let tried = 0;
  let proxyError;
  const proxyTried = Boolean(proxy);
  const proxyMeta = () => ({
    ...(proxyTried ? { tavily_proxy_tried: true } : {}),
    ...(proxyError ? { tavily_proxy_error: proxyError } : {}),
  });

  if (proxy) {
    tried += 1;
    try {
      const result = await fn(proxy.apiKey, -1, keys.length, {
        apiUrl: proxy.apiUrl,
        backend: "proxy",
      });
      if (result?.ok) {
        return { ...result, ...tavilyTargetMeta("proxy", -1, keys.length, tried, proxyMeta()) };
      }
      lastError = String(result?.error || lastError);
      proxyError = redactSecrets(lastError, config);
      debugLog(config, `tavily proxy failed, fall back to official: ${proxyError}`);
    } catch (error) {
      lastError = error?.message || String(error);
      proxyError = redactSecrets(lastError, config);
      debugLog(config, `tavily proxy error, fall back to official: ${proxyError}`);
    }
  }

  if (!keys.length) {
    return { ok: false, error: lastError, ...tavilyTargetMeta("proxy", -1, 0, tried, proxyMeta()) };
  }

  const claimed = nextTavilyApiKey(config);
  const start = claimed?.index ?? 0;
  const officialUrl = tavilyOfficialApiUrl(config);

  for (let offset = 0; offset < keys.length; offset += 1) {
    const index = (start + offset) % keys.length;
    const apiKey = keys[index];
    tried += 1;
    try {
      const result = await fn(apiKey, index, keys.length, {
        apiUrl: officialUrl,
        backend: "official",
      });
      if (result?.ok) {
        return { ...result, ...tavilyTargetMeta("official", index, keys.length, tried, proxyMeta()) };
      }
      const softError = {
        status: parseHttpStatusFromMessage(result?.error),
        message: String(result?.error || ""),
      };
      if (offset < keys.length - 1 && isTavilyKeyExhaustedError(softError)) {
        lastError = softError.message || lastError;
        debugLog(config, `tavily key#${index} soft-fail, try next: ${lastError}`);
        continue;
      }
      return { ...result, ...tavilyTargetMeta("official", index, keys.length, tried, proxyMeta()) };
    } catch (error) {
      lastError = error?.message || String(error);
      if (offset < keys.length - 1 && isTavilyKeyExhaustedError(error)) {
        debugLog(config, `tavily key#${index} exhausted/auth, try next: ${lastError}`);
        continue;
      }
      return { ok: false, error: lastError, ...tavilyTargetMeta("official", index, keys.length, tried, proxyMeta()) };
    }
  }

  return {
    ok: false,
    error: lastError,
    ...tavilyTargetMeta(proxy ? "proxy+official" : "official", undefined, keys.length, tried, proxyMeta()),
  };
}

function skippedTavily(error, extra = {}) {
  return { ok: false, provider: "tavily", skipped: true, error, ...extra };
}

function finishTavily(outcome, extra = {}) {
  if (outcome.skipped) return skippedTavily(outcome.error, extra);
  return { provider: "tavily", ...extra, ...outcome };
}

export async function tavilyExtract(url, config) {
  if (!hasTavilyApiKey(config)) return skippedTavily("TAVILY_API_KEY 未配置");

  const outcome = await withTavilyApiKey(config, async (apiKey, _index, _total, target) => {
    const endpoint = `${(target?.apiUrl || tavilyOfficialApiUrl(config)).replace(/\/+$/, "")}/extract`;
    const data = await requestJson(endpoint, {
      headers: authHeaders(apiKey),
      body: { urls: [url], format: "markdown" },
      ...tavilyRequestOptions(config, target, TAVILY_EXTRACT_TIMEOUT_MS),
    });

    const result = Array.isArray(data?.results) ? data.results[0] : undefined;
    const content = result?.raw_content || result?.content || "";
    if (content.trim()) return { ok: true, provider: "tavily", content, raw: data };

    const failed = Array.isArray(data?.failed_results) ? data.failed_results[0] : undefined;
    return {
      ok: false,
      provider: "tavily",
      error: failed?.error || failed?.message || "Tavily Extract 返回空内容",
      raw: data,
    };
  });

  return finishTavily(outcome);
}

export function sourceFromTavily(result, provider = "tavily") {
  const url = typeof result?.url === "string" ? result.url.trim() : "";
  if (!url) return null;
  return {
    url,
    provider,
    ...(result.title ? { title: String(result.title).trim() } : {}),
    ...(result.content ? { description: String(result.content).trim() } : {}),
    ...(result.published_date ? { published_date: String(result.published_date).trim() } : {}),
    ...(Number.isFinite(result.score) ? { score: result.score } : {}),
  };
}

export async function tavilySearch(query, limit, config, filters = {}) {
  if (!hasTavilyApiKey(config)) return skippedTavily("TAVILY_API_KEY 未配置", { sources: [] });

  const { allowed, excluded } = domainFilters(filters);
  const days = Number.isFinite(filters?.days) && filters.days > 0 ? filters.days : null;

  const outcome = await withTavilyApiKey(config, async (apiKey, _index, _total, target) => {
    const endpoint = `${(target?.apiUrl || tavilyOfficialApiUrl(config)).replace(/\/+$/, "")}/search`;
    const data = await requestJson(endpoint, {
      headers: authHeaders(apiKey),
      body: {
        query,
        max_results: limit,
        search_depth: "advanced",
        include_raw_content: false,
        include_answer: false,
        ...(days != null ? { days } : {}),
        ...(allowed.length ? { include_domains: allowed, include_domains_mode: "filter" } : {}),
        ...(excluded.length ? { exclude_domains: excluded } : {}),
      },
      ...tavilyRequestOptions(config, target, TAVILY_SEARCH_TIMEOUT_MS),
    });
    const rawResults = Array.isArray(data?.results) ? data.results : [];
    const sources = rawResults.map((result) => sourceFromTavily(result)).filter(Boolean);
    // Fall back only when the proxy returned no result objects. Rows that exist but have no
    // usable URL are still a proxy answer; dropping them and calling official would discard
    // the payload and spend another key.
    if (!rawResults.length && target?.backend === "proxy") {
      return { ok: false, provider: "tavily", error: "Tavily proxy 返回空结果", sources, raw: data };
    }
    return { ok: true, provider: "tavily", sources, raw: data };
  });

  return finishTavily(outcome, { sources: [] });
}

export async function tavilyMap(url, options, config) {
  if (!hasTavilyApiKey(config)) return skippedTavily("TAVILY_API_KEY 未配置", { results: [] });

  const body = {
    url,
    max_depth: options.maxDepth,
    max_breadth: options.maxBreadth,
    limit: options.limit,
    timeout: options.timeout,
  };
  if (options.instructions) body.instructions = options.instructions;

  const outcome = await withTavilyApiKey(config, async (apiKey, _index, _total, target) => {
    const endpoint = `${(target?.apiUrl || tavilyOfficialApiUrl(config)).replace(/\/+$/, "")}/map`;
    const data = await requestJson(endpoint, {
      headers: authHeaders(apiKey),
      body,
      ...tavilyRequestOptions(config, target, (options.timeout + 10) * 1000),
    });
    const results = Array.isArray(data?.results) ? data.results.filter((item) => typeof item === "string") : [];
    if (!results.length && target?.backend === "proxy") {
      return { ok: false, provider: "tavily", error: "Tavily proxy 返回空结果", results, raw: data };
    }
    return {
      ok: true,
      provider: "tavily",
      base_url: data?.base_url || new URL(url).origin,
      results,
      response_time: data?.response_time ?? null,
      raw: data,
    };
  });

  return finishTavily(outcome, { results: [] });
}
