import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { configureProxyFromEnv } from "./proxy.js";

configureProxyFromEnv();

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const DIRECT_FETCH_MAX_BYTES = 2 * 1024 * 1024;
const DIRECT_ERROR_PREVIEW_BYTES = 1000;
const DEFAULT_TAVILY_RR_PATH = path.join(homedir(), ".cache", "grok-search", "tavily-rr.json");
const QUOTA_OR_KEY_MESSAGE =
  /insufficient[_-]?quota|quota[_-]?exhausted|credits?[_-]?exhausted|insufficient[_-]?credits?|payment[_-]?required|invalid.?api.?key|unauthorized|api.?key.*(invalid|expired|revoked)|额度|余额|计费/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimBody(text, max = 500) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function allTavilyKeys(config) {
  if (Array.isArray(config?.tavilyApiKeys) && config.tavilyApiKeys.length) {
    return config.tavilyApiKeys.map((k) => String(k || "").trim()).filter(Boolean);
  }
  if (typeof config?.tavilyApiKey === "string" && config.tavilyApiKey.trim()) {
    return [config.tavilyApiKey.trim()];
  }
  return [];
}

function redactSecrets(text, config) {
  let out = String(text || "");
  const secrets = [config?.grokApiKey, config?.firecrawlApiKey, config?.fathomApiKey, config?.mcpTavilyToken, ...allTavilyKeys(config)];
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

export function tavilyRoundRobinPath(config) {
  if (typeof config?.tavilyRoundRobinPath === "string" && config.tavilyRoundRobinPath.trim()) {
    return config.tavilyRoundRobinPath.trim();
  }
  return DEFAULT_TAVILY_RR_PATH;
}

/** Read persistent next index; returns 0 on missing/corrupt. */
export function loadTavilyRoundRobinIndex(keyCount, config) {
  if (!Number.isFinite(keyCount) || keyCount <= 0) return 0;
  try {
    const raw = readFileSync(tavilyRoundRobinPath(config), "utf8");
    const data = JSON.parse(raw);
    const n = Number(data?.nextIndex);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.trunc(n) % keyCount;
  } catch {
    return 0;
  }
}

/** Persist next index for subsequent CLI processes. Best-effort. */
export function saveTavilyRoundRobinIndex(nextIndex, config) {
  try {
    const filePath = tavilyRoundRobinPath(config);
    mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = `${JSON.stringify({ nextIndex: Math.max(0, Math.trunc(nextIndex)), updatedAt: new Date().toISOString() })}\n`;
    writeFileSync(filePath, payload, { encoding: "utf8", mode: 0o600 });
  } catch {
    // ignore — RR degrades to always-start-at-0
  }
}

export function hasTavilyApiKey(config) {
  return allTavilyKeys(config).length > 0;
}

export function hasFathomApiKey(config) {
  return typeof config?.fathomApiKey === "string" && config.fathomApiKey.trim().length > 0;
}

export function hasMcpTavilyConfig(config) {
  return typeof config?.mcpTavilyToken === "string" && config.mcpTavilyToken.trim().length > 0;
}

/**
 * Claim next RR slot (persistent across processes). Returns { key, index, total }.
 * Advances cursor immediately so concurrent/next CLI runs spread load.
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
  // 403 only when message points at key/auth, not content policy.
  if (status === 403) return /invalid.?api.?key|unauthorized|forbidden.*(?:api.?key|token)|api.?key/i.test(msg);
  if (status === 429) return /quota|credit|balance|billing|limit|额度|余额|计费/i.test(msg);
  return QUOTA_OR_KEY_MESSAGE.test(msg);
}

function shouldRetryHttpError(error) {
  // No HTTP status (network/timeout): keep original retry behavior via caller.
  if (!error?.status) return true;
  if (error.status === 401 || error.status === 402 || error.status === 403) return false;
  if (error.status === 429 && isTavilyKeyExhaustedError(error)) return false;
  return RETRYABLE_STATUS.has(error.status);
}

/**
 * Run fn(apiKey) starting at persistent RR index; on quota/auth failure try remaining keys once each.
 */
export async function withTavilyApiKey(config, fn) {
  const keys = allTavilyKeys(config);
  if (!keys.length) {
    return { skipped: true, error: "TAVILY_API_KEY 未配置" };
  }

  const claimed = nextTavilyApiKey(config);
  const start = claimed?.index ?? 0;

  let lastError = "Tavily request failed";
  let tried = 0;
  for (let offset = 0; offset < keys.length; offset += 1) {
    const index = (start + offset) % keys.length;
    const apiKey = keys[index];
    tried += 1;
    try {
      const result = await fn(apiKey, index, keys.length);
      if (result?.ok) {
        return {
          ...result,
          tavily_key_index: index,
          tavily_key_total: keys.length,
          tavily_keys_tried: tried,
        };
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
      return {
        ...result,
        tavily_key_index: index,
        tavily_key_total: keys.length,
        tavily_keys_tried: tried,
      };
    } catch (error) {
      lastError = error?.message || String(error);
      if (offset < keys.length - 1 && isTavilyKeyExhaustedError(error)) {
        debugLog(config, `tavily key#${index} exhausted/auth, try next: ${lastError}`);
        continue;
      }
      return {
        ok: false,
        error: lastError,
        tavily_key_index: index,
        tavily_key_total: keys.length,
        tavily_keys_tried: tried,
      };
    }
  }

  return {
    ok: false,
    error: lastError,
    tavily_key_total: keys.length,
    tavily_keys_tried: tried,
  };
}

export function retryAfterMs(headers) {
  const value = headers.get("retry-after");
  if (!value) return null;

  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

export function backoffMs(config, attemptIndex) {
  const maxWaitMs = config.retryMaxWait * 1000;
  const computed = config.retryMultiplier * 1000 * 2 ** attemptIndex;
  return Math.min(maxWaitMs, computed);
}

export function debugLog(config, message) {
  if (config?.debug) console.error(`[grok-search] ${message}`);
}

export async function requestJson(url, { headers, body, timeoutMs, config, retry = false }) {
  const maxAttempts = retry ? config.retryMaxAttempts : 1;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      clearTimeout(timer);

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${redactSecrets(trimBody(text), config)}`);
        error.status = response.status;
        error.retryAfterMs = retryAfterMs(response.headers);
        throw error;
      }

      try {
        return text ? JSON.parse(text) : {};
      } catch (cause) {
        const error = new Error(`响应不是有效 JSON: ${redactSecrets(trimBody(text), config)}`);
        error.cause = cause;
        throw error;
      }
    } catch (error) {
      clearTimeout(timer);
      if (error.name === "AbortError") {
        lastError = new Error(`请求超时（>${Math.round(timeoutMs / 1000)}s）`);
        lastError.retryable = true;
      } else {
        lastError = error;
      }

      const canRetry =
        attempt < maxAttempts - 1 && (lastError.retryable || shouldRetryHttpError(lastError));
      if (!canRetry) break;

      const waitMs = lastError.retryAfterMs ?? backoffMs(config, attempt);
      debugLog(config, `retry ${attempt + 1}/${maxAttempts - 1} after ${Math.round(waitMs)}ms: ${lastError.message}`);
      await sleep(waitMs);
    }
  }

  throw lastError;
}

export function authHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

export function firecrawlAuthMode(config) {
  return config?.firecrawlApiKey ? "api_key" : "keyless";
}

function firecrawlHeaders(config) {
  return config?.firecrawlApiKey
    ? authHeaders(config.firecrawlApiKey)
    : { "Content-Type": "application/json" };
}

export async function tavilyExtract(url, config) {
  if (!hasTavilyApiKey(config)) {
    return { ok: false, provider: "tavily", skipped: true, error: "TAVILY_API_KEY 未配置" };
  }

  const endpoint = `${config.tavilyApiUrl.replace(/\/+$/, "")}/extract`;
  const outcome = await withTavilyApiKey(config, async (apiKey) => {
    const data = await requestJson(endpoint, {
      headers: authHeaders(apiKey),
      body: { urls: [url], format: "markdown" },
      timeoutMs: 60_000,
      config,
      retry: true,
    });

    const result = Array.isArray(data?.results) ? data.results[0] : undefined;
    const content = result?.raw_content || result?.content || "";
    if (content.trim()) {
      return { ok: true, provider: "tavily", content, raw: data };
    }

    const failed = Array.isArray(data?.failed_results) ? data.failed_results[0] : undefined;
    return {
      ok: false,
      provider: "tavily",
      error: failed?.error || failed?.message || "Tavily Extract 返回空内容",
      raw: data,
    };
  });

  if (outcome.skipped) {
    return { ok: false, provider: "tavily", skipped: true, error: outcome.error };
  }
  return { provider: "tavily", ...outcome };
}

export async function firecrawlScrape(url, config) {
  const endpoint = `${config.firecrawlApiUrl.replace(/\/+$/, "")}/scrape`;
  const authMode = firecrawlAuthMode(config);
  let lastError = "Firecrawl Scrape 返回空内容";

  for (let attempt = 0; attempt < config.retryMaxAttempts; attempt += 1) {
    try {
      const data = await requestJson(endpoint, {
        headers: firecrawlHeaders(config),
        body: {
          url,
          formats: ["markdown"],
          timeout: 60_000,
          waitFor: (attempt + 1) * 1500,
        },
        timeoutMs: 90_000,
        config,
        retry: false,
      });

      const content = data?.data?.markdown || data?.markdown || "";
      if (content.trim()) {
        return {
          ok: true,
          provider: "firecrawl",
          auth_mode: authMode,
          content,
          raw: data,
          attempts: attempt + 1,
          ...(Number.isFinite(data?.data?.metadata?.creditsUsed) ? { credits_used: data.data.metadata.creditsUsed } : {}),
        };
      }

      lastError = "Firecrawl Scrape 返回空内容";
      debugLog(config, `Firecrawl empty markdown, retry ${attempt + 1}/${config.retryMaxAttempts}`);
    } catch (error) {
      lastError = error.message;
      if (error.status && !RETRYABLE_STATUS.has(error.status)) break;
      debugLog(config, `Firecrawl error, retry ${attempt + 1}/${config.retryMaxAttempts}: ${error.message}`);
    }

    if (attempt < config.retryMaxAttempts - 1) {
      await sleep(backoffMs(config, attempt));
    }
  }

  return { ok: false, provider: "firecrawl", auth_mode: authMode, error: lastError };
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

function sourceFromFirecrawl(result) {
  const url = typeof result?.url === "string" ? result.url.trim() : "";
  if (!url) return null;
  return {
    url,
    provider: "firecrawl",
    ...(result.title ? { title: String(result.title).trim() } : {}),
    ...(result.description ? { description: String(result.description).trim() } : {}),
  };
}

export async function tavilySearch(query, limit, config, days = null) {
  if (!hasTavilyApiKey(config)) {
    return { ok: false, provider: "tavily", skipped: true, error: "TAVILY_API_KEY 未配置", sources: [] };
  }

  const endpoint = `${config.tavilyApiUrl.replace(/\/+$/, "")}/search`;
  const outcome = await withTavilyApiKey(config, async (apiKey) => {
    const body = {
      query,
      max_results: limit,
      search_depth: "advanced",
      include_raw_content: false,
      include_answer: false,
    };

    if (days !== null && Number.isFinite(days) && days > 0) {
      body.days = days;
    }

    const data = await requestJson(endpoint, {
      headers: authHeaders(apiKey),
      body,
      timeoutMs: 90_000,
      config,
      retry: true,
    });
    const sources = (Array.isArray(data?.results) ? data.results : []).map((result) => sourceFromTavily(result)).filter(Boolean);
    return { ok: true, provider: "tavily", sources, raw: data };
  });

  if (outcome.skipped) {
    return { ok: false, provider: "tavily", skipped: true, error: outcome.error, sources: [] };
  }
  return { provider: "tavily", sources: [], ...outcome };
}

export async function firecrawlSearch(query, limit, config) {
  const endpoint = `${config.firecrawlApiUrl.replace(/\/+$/, "")}/search`;
  const authMode = firecrawlAuthMode(config);
  try {
    const data = await requestJson(endpoint, {
      headers: firecrawlHeaders(config),
      body: { query, limit },
      timeoutMs: 90_000,
      config,
      retry: true,
    });
    const rawResults = Array.isArray(data?.data?.web)
      ? data.data.web
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.web)
          ? data.web
          : [];
    const sources = rawResults.map(sourceFromFirecrawl).filter(Boolean);
    return {
      ok: true,
      provider: "firecrawl",
      auth_mode: authMode,
      sources,
      raw: data,
      ...(Number.isFinite(data?.creditsUsed) ? { credits_used: data.creditsUsed } : {}),
    };
  } catch (error) {
    return { ok: false, provider: "firecrawl", auth_mode: authMode, error: error.message, sources: [] };
  }
}

export async function fathomSearch(query, limit, config) {
  if (!hasFathomApiKey(config)) {
    return { ok: false, provider: "fathom", skipped: true, error: "FATHOM_API_KEY 未配置", sources: [] };
  }

  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

    const transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "@fathom-search/mcp-server"],
      env: {
        ...process.env,
        FATHOM_API_KEY: config.fathomApiKey,
        FATHOM_API_URL: config.fathomApiUrl || "https://fathomsearch.xyz/mcp",
      },
    });

    const client = new Client(
      { name: "grok-search", version: "0.1.0" },
      { capabilities: {} }
    );

    await client.connect(transport);

    const toolName = config.fathomSearchTool || "mega_search";
    const toolArgs = {
      query,
      max_results: limit,
    };

    if (config.fathomEngines && config.fathomEngines.trim()) {
      toolArgs.engines = config.fathomEngines.trim();
    }

    const response = await client.callTool({ name: toolName, arguments: toolArgs });

    await client.close();

    if (!response || !Array.isArray(response.content)) {
      return { ok: false, provider: "fathom", error: "Fathom 返回格式无效", sources: [] };
    }

    const textContent = response.content.find((c) => c.type === "text");
    if (!textContent || !textContent.text) {
      return { ok: false, provider: "fathom", error: "Fathom 未返回文本内容", sources: [] };
    }

    let data;
    try {
      data = JSON.parse(textContent.text);
    } catch {
      return { ok: false, provider: "fathom", error: "Fathom 返回的 JSON 解析失败", sources: [] };
    }

    const rawResults = Array.isArray(data?.results) ? data.results : [];
    const sources = rawResults
      .map((r) => {
        if (!r || typeof r.url !== "string" || !r.url.trim()) return null;
        return {
          url: r.url.trim(),
          provider: "fathom",
          ...(r.title ? { title: String(r.title).trim() } : {}),
          ...(r.snippet ? { snippet: String(r.snippet).trim() } : {}),
          ...(r.description ? { description: String(r.description).trim() } : {}),
        };
      })
      .filter(Boolean);

    return { ok: true, provider: "fathom", sources, raw: data };
  } catch (error) {
    return { ok: false, provider: "fathom", error: error.message, sources: [] };
  }
}

const TRANSIENT_MCP_TAVILY_PATTERN =
  /fetch failed|econnreset|econnrefused|econnaborted|eai_again|eai_noname|enetdown|enetunreach|ehostunreach|etimedout|epipe|socket hang up|connection reset|connection refused|network error/i;

export function isTransientMcpTavilyError(error) {
  const text = `${error?.message || ""} ${error?.cause?.code || ""} ${error?.cause?.message || ""}`.toLowerCase();
  return TRANSIENT_MCP_TAVILY_PATTERN.test(text);
}

function mcpTavilyErrorDetail(error) {
  const message = error?.message || "unknown error";
  const cause = error?.cause;
  if (!cause) return message;
  const detail = cause.code || cause.message || String(cause);
  return detail ? `${message} (${detail})` : message;
}

async function mcpTavilyAttempt({ url, token, toolName, toolArgs }) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
  });

  const client = new Client({ name: "grok-search", version: "0.1.0" }, { capabilities: {} });

  const run = (async () => {
    await client.connect(transport);
    const response = await client.callTool({ name: toolName, arguments: toolArgs });
    await client.close();
    return response;
  })();

  let timeoutId;
  const timeout = new Promise((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("MCP Tavily 请求超时（>60s）"));
      client.close().catch(() => {});
    }, 60_000);
  });

  let response;
  try {
    response = await Promise.race([run, timeout]);
  } catch (error) {
    clearTimeout(timeoutId);
    return { ok: false, error };
  }
  clearTimeout(timeoutId);

  if (!response || (!Array.isArray(response.content) && !response.structuredContent)) {
    return { ok: false, error: new Error("MCP Tavily 返回格式无效") };
  }

  let data;
  if (response.structuredContent) {
    data = response.structuredContent;
  } else {
    const textContent = response.content.find((c) => c.type === "text");
    if (!textContent || !textContent.text) {
      return { ok: false, error: new Error("MCP Tavily 未返回文本内容") };
    }
    try {
      data = JSON.parse(textContent.text);
    } catch {
      return { ok: false, error: new Error("MCP Tavily 返回的 JSON 解析失败") };
    }
  }

  return { ok: true, data };
}

export async function mcpTavilySearch(query, limit, config, days = null) {
  if (!hasMcpTavilyConfig(config)) {
    return { ok: false, provider: "mcpTavily", skipped: true, error: "MCP_TAVILY_TOKEN 未配置", sources: [] };
  }

  try {
    const toolName = config.mcpTavilyTool || "search_proxy_tavily_search";
    const toolArgs = {
      query,
      max_results: limit,
      search_depth: "advanced",
    };
    if (days !== null && Number.isFinite(days) && days > 0) {
      toolArgs.days = days;
    }

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) await sleep(300);
      const outcome = await mcpTavilyAttempt({
        url: config.mcpTavilyUrl,
        token: config.mcpTavilyToken,
        toolName,
        toolArgs,
      });
      if (outcome.ok) {
        const rawResults = Array.isArray(outcome.data?.results) ? outcome.data.results : [];
        const sources = rawResults.map((result) => sourceFromTavily(result, "mcpTavily")).filter(Boolean);
        return { ok: true, provider: "mcpTavily", sources, raw: outcome.data };
      }
      lastError = outcome.error;
      if (!isTransientMcpTavilyError(outcome.error)) break;
    }

    return { ok: false, provider: "mcpTavily", error: mcpTavilyErrorDetail(lastError), sources: [] };
  } catch (error) {
    return { ok: false, provider: "mcpTavily", error: mcpTavilyErrorDetail(error), sources: [] };
  }
}

export async function tavilyMap(url, options, config) {
  if (!hasTavilyApiKey(config)) {
    return { ok: false, provider: "tavily", skipped: true, error: "TAVILY_API_KEY 未配置", results: [] };
  }

  const endpoint = `${config.tavilyApiUrl.replace(/\/+$/, "")}/map`;
  const body = {
    url,
    max_depth: options.maxDepth,
    max_breadth: options.maxBreadth,
    limit: options.limit,
    timeout: options.timeout,
  };
  if (options.instructions) body.instructions = options.instructions;

  const outcome = await withTavilyApiKey(config, async (apiKey) => {
    const data = await requestJson(endpoint, {
      headers: authHeaders(apiKey),
      body,
      timeoutMs: (options.timeout + 10) * 1000,
      config,
      retry: true,
    });
    return {
      ok: true,
      provider: "tavily",
      base_url: data?.base_url || new URL(url).origin,
      results: Array.isArray(data?.results) ? data.results.filter((item) => typeof item === "string") : [],
      response_time: data?.response_time ?? null,
      raw: data,
    };
  });

  if (outcome.skipped) {
    return { ok: false, provider: "tavily", skipped: true, error: outcome.error, results: [] };
  }
  return { provider: "tavily", results: [], ...outcome };
}

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function fetchTextForMap(url, timeoutSeconds) {
  const timeout = withTimeout(timeoutSeconds * 1000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: timeout.signal,
      headers: {
        Accept: "application/xml,text/xml,text/html,*/*;q=0.8",
        "User-Agent": "grok-search-skill/0.1",
      },
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}: ${response.statusText || "请求失败"}` };
    }
    if (!isTextualContentType(contentType)) {
      return { ok: false, status: response.status, error: "响应不是文本内容" };
    }
    const contentLength = headerNumber(response.headers, "content-length");
    if (contentLength != null && contentLength > DIRECT_FETCH_MAX_BYTES) {
      return { ok: false, status: response.status, error: `响应超过 Direct Map 首版上限 ${DIRECT_FETCH_MAX_BYTES} bytes` };
    }
    const body = await readTextWithLimit(response, DIRECT_FETCH_MAX_BYTES);
    if (body.exceeded) {
      return { ok: false, status: response.status, error: `响应超过 Direct Map 首版上限 ${DIRECT_FETCH_MAX_BYTES} bytes` };
    }
    return { ok: true, status: response.status, final_url: response.url || url, text: body.text, content_type: contentType };
  } catch (error) {
    const message = error.name === "AbortError" ? `请求超时（>${timeoutSeconds}s）` : error.message;
    return { ok: false, error: message };
  } finally {
    timeout.clear();
  }
}

function uniqueLimited(urls, limit) {
  const seen = new Set();
  const out = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

function parseSitemapUrls(xml, base, limit) {
  const baseUrl = new URL(base);
  const urls = [];
  for (const match of String(xml || "").matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
    try {
      const parsed = new URL(decodeHtmlEntities(match[1].trim()), baseUrl);
      parsed.hash = "";
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      if (parsed.hostname !== baseUrl.hostname) continue;
      urls.push(parsed.toString());
    } catch {
      // Ignore malformed sitemap entries.
    }
  }
  return uniqueLimited(urls, limit);
}

function hrefValues(html) {
  const values = [];
  for (const match of String(html || "").matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    values.push(match[1] || match[2] || match[3] || "");
  }
  return values;
}

function parseHtmlLinks(html, pageUrl, limit, maxBreadth) {
  const baseUrl = new URL(pageUrl);
  const urls = [];
  for (const href of hrefValues(html)) {
    try {
      const parsed = new URL(decodeHtmlEntities(href.trim()), baseUrl);
      parsed.hash = "";
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      if (parsed.hostname !== baseUrl.hostname) continue;
      urls.push(parsed.toString());
      if (urls.length >= maxBreadth) break;
    } catch {
      // Ignore malformed hrefs.
    }
  }
  return uniqueLimited(urls, limit);
}

export async function directMap(url, options = {}) {
  const warnings = [];
  const parsed = new URL(url);
  const baseUrl = parsed.origin;
  const limit = options.limit || 50;
  const maxBreadth = options.maxBreadth || 20;
  const timeout = options.timeout || 150;
  const instructionsIgnored = Boolean(options.instructions);

  if (instructionsIgnored) {
    warnings.push("Direct Map does not support instructions; ignored.");
  }
  if ((options.maxDepth || 1) > 1) {
    warnings.push("Direct Map only supports max-depth 1; deeper traversal requires Tavily Map.");
  }

  const sitemapUrl = new URL("/sitemap.xml", baseUrl).toString();
  const sitemap = await fetchTextForMap(sitemapUrl, timeout);
  if (sitemap.ok) {
    const results = parseSitemapUrls(sitemap.text, baseUrl, limit);
    if (results.length) {
      return {
        ok: true,
        provider: "direct",
        base_url: baseUrl,
        results,
        response_time: null,
        warnings,
        instructions_ignored: instructionsIgnored,
      };
    }
    warnings.push("Direct Map found sitemap.xml but no same-domain URLs were parsed.");
  } else {
    warnings.push(`Direct Map sitemap skipped: ${sitemap.error}`);
  }

  const homeUrl = new URL("/", baseUrl).toString();
  const home = await fetchTextForMap(homeUrl, timeout);
  if (!home.ok) {
    return {
      ok: false,
      provider: "direct",
      base_url: baseUrl,
      results: [],
      error: `Direct Map failed: ${home.error}`,
      warnings,
      instructions_ignored: instructionsIgnored,
    };
  }

  const results = parseHtmlLinks(home.text, home.final_url || homeUrl, limit, maxBreadth);
  return {
    ok: true,
    provider: "direct",
    base_url: baseUrl,
    results,
    response_time: null,
    warnings,
    instructions_ignored: instructionsIgnored,
  };
}

function summarizeMapFailure(tried, fallback) {
  const details = tried
    .filter((item) => item.error)
    .map((item) => `${item.provider}: ${item.error}`)
    .join("; ");
  return details ? `映射失败: ${details}` : fallback || "映射失败";
}

export async function mapUrl(url, config, { provider = "auto", ...options } = {}) {
  const tried = [];

  if (provider === "direct") {
    const result = await directMap(url, options);
    tried.push({ provider: result.provider, ok: result.ok, skipped: false, error: result.error });
    return { ...result, tried };
  }

  if (provider === "auto" || provider === "tavily") {
    const result = await tavilyMap(url, options, config);
    tried.push({ provider: result.provider, ok: result.ok, skipped: Boolean(result.skipped), error: result.error });
    if (result.ok || provider === "tavily") return { ...result, tried };
  }

  if (provider === "auto") {
    const result = await directMap(url, options);
    tried.push({ provider: result.provider, ok: result.ok, skipped: false, error: result.error });
    if (result.ok) return { ...result, tried };
    return { ...result, tried, error: summarizeMapFailure(tried, result.error) };
  }

  return { ok: false, provider, results: [], tried, error: `未知 provider: ${provider}` };
}

function headerNumber(headers, name) {
  const value = headers.get(name);
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isLikelyAttachment(headers) {
  const disposition = headers.get("content-disposition") || "";
  return /attachment/i.test(disposition);
}

function isTextualContentType(contentType) {
  const type = (contentType || "").toLowerCase().split(";")[0].trim();
  if (!type) return true;
  if (type.startsWith("text/")) return true;
  return [
    "application/json",
    "application/ld+json",
    "application/javascript",
    "application/x-javascript",
    "application/xml",
    "application/xhtml+xml",
    "application/rss+xml",
    "application/atom+xml",
    "image/svg+xml",
  ].includes(type);
}

async function readTextWithLimit(response, limitBytes) {
  const reader = response.body?.getReader();
  if (!reader) return { text: await response.text(), exceeded: false };

  const chunks = [];
  let total = 0;
  let exceeded = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limitBytes) {
      const used = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const remaining = Math.max(0, limitBytes - used);
      if (remaining > 0) chunks.push(value.slice(0, remaining));
      exceeded = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), exceeded };
}

function decodeHtmlEntities(text) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "-",
    mdash: "-",
    hellip: "...",
  };

  return String(text || "").replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : match;
  });
}

function stripHtmlToReadableText(html) {
  const withoutComments = String(html || "").replace(/<!--[\s\S]*?-->/g, " ");
  const titleMatch = withoutComments.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, " ").trim()) : "";

  let body = withoutComments
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<title\b[\s\S]*?<\/title>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(h[1-6])\b[^>]*>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|nav|aside|blockquote|pre|tr|table|ul|ol|dl|dt|dd)>/gi, "\n")
    .replace(/<(p|div|section|article|header|footer|main|nav|aside|blockquote|pre|tr|table|ul|ol|dl|dt|dd)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  body = decodeHtmlEntities(body)
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (title && !body.startsWith(title)) {
    return `# ${title}\n\n${body}`.trim();
  }
  return body;
}

function renderDirectContent(text, contentType) {
  const type = (contentType || "").toLowerCase();
  if (type.includes("html")) return stripHtmlToReadableText(text);
  if (type.includes("json")) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text.trim();
    }
  }
  return text.trim();
}

function directMetadata(response, contentLength) {
  return {
    status: response.status,
    content_type: response.headers.get("content-type") || null,
    content_length: contentLength,
    content_disposition: response.headers.get("content-disposition") || null,
  };
}

export async function directFetch(url, options = {}) {
  const maxBytes = options.maxBytes || DIRECT_FETCH_MAX_BYTES;
  const warnings = [];
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const finish = (value) => {
    clearTimeout(timer);
    return value;
  };

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml,application/json,text/plain,text/markdown,*/*;q=0.8",
        "User-Agent": "grok-search-skill/0.1",
      },
    });
    const finalUrl = response.url || url;
    const redirected = finalUrl !== url;
    const contentLength = headerNumber(response.headers, "content-length");
    const contentType = response.headers.get("content-type") || "";
    const metadata = directMetadata(response, contentLength);

    if (!response.ok) {
      const preview = await readTextWithLimit(response, DIRECT_ERROR_PREVIEW_BYTES);
      return finish({
        ok: false,
        provider: "direct",
        final_url: finalUrl,
        redirected,
        error: `HTTP ${response.status}: ${response.statusText || "请求失败"}`,
        error_preview: preview.text ? trimBody(preview.text, DIRECT_ERROR_PREVIEW_BYTES) : null,
        metadata,
        warnings,
      });
    }

    if (isLikelyAttachment(response.headers) || !isTextualContentType(contentType)) {
      return finish({
        ok: false,
        provider: "direct",
        final_url: finalUrl,
        redirected,
        error: "目标看起来是二进制或附件，未注入正文",
        error_preview: null,
        metadata,
        warnings,
      });
    }

    if (contentLength != null && contentLength > maxBytes) {
      return finish({
        ok: false,
        provider: "direct",
        final_url: finalUrl,
        redirected,
        error: `响应超过 Direct Fetch 首版上限 ${maxBytes} bytes，未下载正文`,
        error_preview: null,
        metadata,
        warnings,
      });
    }

    const body = await readTextWithLimit(response, maxBytes);
    if (body.exceeded) {
      return finish({
        ok: false,
        provider: "direct",
        final_url: finalUrl,
        redirected,
        error: `响应超过 Direct Fetch 首版上限 ${maxBytes} bytes，未注入正文`,
        error_preview: null,
        metadata: { ...metadata, content_length: null },
        warnings,
      });
    }

    const content = renderDirectContent(body.text, contentType);
    if (!content) warnings.push("Direct Fetch 返回空文本；页面可能依赖 JavaScript 渲染或无正文。");

    return finish({
      ok: true,
      provider: "direct",
      content,
      final_url: finalUrl,
      redirected,
      metadata,
      warnings,
    });
  } catch (error) {
    clearTimeout(timer);
    const message = error.name === "AbortError" ? `请求超时（>${Math.round(timeoutMs / 1000)}s）` : error.message;
    return {
      ok: false,
      provider: "direct",
      error: message,
      error_preview: null,
      metadata: {},
      warnings,
    };
  }
}

function summarizeFetchFailure(tried, fallback) {
  const details = tried
    .filter((item) => item.error)
    .map((item) => `${item.provider}: ${item.error}`)
    .join("; ");
  return details ? `提取失败: ${details}` : fallback || "提取失败: 所有提取服务均未能获取内容";
}

export async function fetchUrl(url, config, { provider = "auto" } = {}) {
  const tried = [];

  if (provider === "direct") {
    const result = await directFetch(url);
    tried.push({ provider: result.provider, ok: result.ok, skipped: false, error: result.error });
    return { ...result, tried };
  }

  if (provider === "auto" || provider === "tavily") {
    const result = await tavilyExtract(url, config);
    tried.push({ provider: result.provider, ok: result.ok, skipped: Boolean(result.skipped), error: result.error });
    if (result.ok || provider === "tavily") return { ...result, tried };
  }

  if (provider === "auto" || provider === "firecrawl") {
    const result = await firecrawlScrape(url, config);
    tried.push({
      provider: result.provider,
      ok: result.ok,
      skipped: Boolean(result.skipped),
      error: result.error,
      auth_mode: result.auth_mode,
      ...(result.credits_used == null ? {} : { credits_used: result.credits_used }),
    });
    if (result.ok || provider === "firecrawl") return { ...result, tried };
  }

  if (provider === "auto") {
    const result = await directFetch(url);
    tried.push({ provider: result.provider, ok: result.ok, skipped: false, error: result.error });
    if (result.ok) return { ...result, tried };
    return { ...result, tried, error: summarizeFetchFailure(tried, result.error) };
  }

  return { ok: false, provider, tried, error: `未知 provider: ${provider}` };
}
