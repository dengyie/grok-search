#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveTavilyApiKeys } from "../scripts/lib/config.js";
import { extraAllocation } from "../scripts/search.js";
import {
  hasTavilyApiKey,
  isTavilyKeyExhaustedError,
  loadTavilyRoundRobinIndex,
  nextTavilyApiKey,
  withTavilyApiKey,
} from "../scripts/lib/providers.js";

function noEnv() {
  return undefined;
}

assert.deepEqual(
  resolveTavilyApiKeys({ tavilyApiKeys: [], tavilyApiKey: "tvly-real" }, noEnv),
  ["tvly-real"],
  "empty tavilyApiKeys must not swallow tavilyApiKey"
);
assert.deepEqual(resolveTavilyApiKeys({ tavilyApiKey: "tvly-real" }, noEnv), ["tvly-real"]);
assert.deepEqual(
  resolveTavilyApiKeys({ tavilyApiKeys: ["a", "b"], tavilyApiKey: "c" }, noEnv),
  ["a", "b", "c"],
  "file multi + single merge"
);
assert.deepEqual(resolveTavilyApiKeys({ tavilyApiKeys: ["a", "a", "b"] }, noEnv), ["a", "b"]);
assert.deepEqual(
  resolveTavilyApiKeys({}, (name) => (name === "TAVILY_API_KEYS" ? "k1, k2, k1" : undefined)),
  ["k1", "k2"],
  "env multi wins and dedupes"
);
assert.deepEqual(
  resolveTavilyApiKeys({ tavilyApiKeys: ["file"] }, (name) => (name === "TAVILY_API_KEY" ? "env-single" : undefined)),
  ["env-single"],
  "single env key beats the file"
);

assert.equal(isTavilyKeyExhaustedError({ status: 401, message: "HTTP 401: no" }), true);
assert.equal(isTavilyKeyExhaustedError({ status: 402, message: "payment required" }), true);
assert.equal(isTavilyKeyExhaustedError({ status: 403, message: "HTTP 403: forbidden by WAF" }), false);
assert.equal(isTavilyKeyExhaustedError({ status: 403, message: "HTTP 403: invalid api key" }), true);
assert.equal(isTavilyKeyExhaustedError({ status: 429, message: "rate limit please slow down" }), false);
assert.equal(isTavilyKeyExhaustedError({ status: 429, message: "HTTP 429: quota exceeded" }), true);
assert.equal(isTavilyKeyExhaustedError({ status: 429, message: "too many requests" }), false);
assert.equal(isTavilyKeyExhaustedError({ message: "Tavily Extract 返回空内容" }), false);
assert.equal(isTavilyKeyExhaustedError({ message: "HTTP 402: credits exhausted" }), true);
assert.equal(isTavilyKeyExhaustedError({ message: "empty body" }), false);

const dir = mkdtempSync(path.join(tmpdir(), "grok-search-tavily-rr-"));
const rrPath = path.join(dir, "tavily-rr.json");
const cfg = {
  tavilyApiKeys: ["k0", "k1", "k2"],
  tavilyApiKey: "k0",
  tavilyRoundRobinPath: rrPath,
  retryMaxAttempts: 1,
  retryMaxWait: 0,
  retryMultiplier: 0,
};
try {
  const claimed = [];
  for (let i = 0; i < 5; i += 1) claimed.push(nextTavilyApiKey(cfg).index);
  assert.deepEqual(claimed, [0, 1, 2, 0, 1], "persistent RR order");
  const stored = JSON.parse(readFileSync(rrPath, "utf8"));
  assert.equal(loadTavilyRoundRobinIndex(3, cfg), stored.nextIndex % 3);

  rmSync(rrPath, { force: true });
  const seen = [];
  const outcome = await withTavilyApiKey(cfg, async (apiKey, index) => {
    seen.push(index);
    if (apiKey === "k0") return { ok: false, error: "HTTP 402: quota" };
    return { ok: true, provider: "tavily" };
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.tavily_backend, "official");
  assert.equal(outcome.tavily_key_index, 1);
  assert.deepEqual(seen, [0, 1], "failover from key0 to key1");
  assert.equal(outcome.tavily_keys_tried, 2);

  rmSync(rrPath, { force: true });
  const seen2 = [];
  const fail = await withTavilyApiKey(cfg, async (_apiKey, index) => {
    seen2.push(index);
    return { ok: false, error: "HTTP 500: boom" };
  });
  assert.equal(fail.ok, false);
  assert.deepEqual(seen2, [0], "non-quota errors must not scan all keys");

  assert.equal(
  extraAllocation(6, { tavilyProxyUrl: "https://tavily.example/api/tavily", tavilyProxyKey: "th-proxy" }).tavily > 0,
  true,
  "proxy credentials alone must count as a Tavily source"
);
assert.equal(extraAllocation(6, {}).tavily, 0);
assert.equal(hasTavilyApiKey({ tavilyProxyUrl: "https://tavily.example/api/tavily", tavilyProxyKey: "th-proxy" }), true);
  assert.equal(hasTavilyApiKey({ tavilyProxyUrl: "https://tavily.example/api/tavily" }), false);

  const proxyRr = path.join(dir, "proxy-rr.json");
  const proxySeen = [];
  const proxyHit = await withTavilyApiKey(
    { ...cfg, tavilyProxyUrl: "https://proxy.example/api", tavilyProxyKey: "th-secret", tavilyRoundRobinPath: proxyRr },
    async (apiKey, index, _total, target) => {
      proxySeen.push({ apiKey, index, backend: target.backend });
      return { ok: true, provider: "tavily" };
    }
  );
  assert.equal(proxyHit.ok, true);
  assert.equal(proxyHit.tavily_backend, "proxy");
  assert.equal(proxyHit.tavily_key_index, -1);
  assert.equal(proxyHit.tavily_keys_tried, 1);
  assert.deepEqual(proxySeen, [{ apiKey: "th-secret", index: -1, backend: "proxy" }]);
  assert.equal(proxyHit.tavily_proxy_tried, true);
  assert.equal(proxyHit.tavily_proxy_error, undefined);
  assert.throws(() => readFileSync(proxyRr), /ENOENT/, "proxy success must not write the official RR file");

  const fallbackSeen = [];
  const fallback = await withTavilyApiKey(
    { ...cfg, tavilyProxyUrl: "https://proxy.example/api", tavilyProxyKey: "th-secret-key", tavilyRoundRobinPath: path.join(dir, "fallback-rr.json") },
    async (apiKey, _index, _total, target) => {
      fallbackSeen.push(target.backend);
      if (target.backend === "proxy") throw new Error("HTTP 502: th-secret-key rejected");
      return { ok: true, provider: "tavily", apiKey };
    }
  );
  assert.equal(fallback.ok, true);
  assert.equal(fallback.tavily_backend, "official");
  assert.equal(fallback.tavily_key_index, 0);
  assert.equal(fallback.tavily_keys_tried, 2);
  assert.deepEqual(fallbackSeen, ["proxy", "official"]);
  assert.equal(fallback.tavily_proxy_tried, true);
  assert.match(String(fallback.tavily_proxy_error), /HTTP 502/);
  assert.doesNotMatch(String(fallback.tavily_proxy_error), /th-secret-key/);

  const softSeen = [];
  const softFail = await withTavilyApiKey(
    { ...cfg, tavilyProxyUrl: "https://proxy.example/api", tavilyProxyKey: "th-proxy", tavilyRoundRobinPath: path.join(dir, "soft-rr.json") },
    async (_apiKey, _index, _total, target) => {
      softSeen.push(target.backend);
      if (target.backend === "proxy") return { ok: false, error: "Tavily proxy 返回空结果" };
      return { ok: true, provider: "tavily" };
    }
  );
  assert.equal(softFail.ok, true);
  assert.equal(softFail.tavily_backend, "official");
  assert.deepEqual(softSeen, ["proxy", "official"]);
  assert.match(String(softFail.tavily_proxy_error), /空结果/);

  rmSync(path.join(dir, "rate-rr.json"), { force: true });
  const rateSeen = [];
  const rateLimited = await withTavilyApiKey(
    { ...cfg, tavilyRoundRobinPath: path.join(dir, "rate-rr.json") },
    async (_apiKey, index) => {
      rateSeen.push(index);
      return { ok: false, error: "HTTP 429: rate limit please slow down" };
    }
  );
  assert.equal(rateLimited.ok, false);
  assert.deepEqual(rateSeen, [0], "a transient 429 must not scan the key pool");

  rmSync(path.join(dir, "empty-extract-rr.json"), { force: true });
  const emptyExtractSeen = [];
  const emptyExtract = await withTavilyApiKey(
    { ...cfg, tavilyRoundRobinPath: path.join(dir, "empty-extract-rr.json") },
    async (_apiKey, index) => {
      emptyExtractSeen.push(index);
      return { ok: false, error: "Tavily Extract 返回空内容" };
    }
  );
  assert.equal(emptyExtract.ok, false);
  assert.deepEqual(emptyExtractSeen, [0], "empty extract content must not scan the key pool");

  const proxyOnly = await withTavilyApiKey(
    { tavilyProxyUrl: "https://proxy.example/api", tavilyProxyKey: "th-only", tavilyApiKeys: [] },
    async () => ({ ok: false, error: "HTTP 500: proxy down" })
  );
  assert.equal(proxyOnly.ok, false);
  assert.equal(proxyOnly.tavily_backend, "proxy");
  assert.equal(proxyOnly.tavily_keys_tried, 1);

  console.log("tavily-keys.test.js: ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
