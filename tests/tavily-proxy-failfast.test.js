#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tavilyMap, tavilySearch } from "../scripts/lib/providers.js";

function listen(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const dir = mkdtempSync(path.join(tmpdir(), "grok-search-proxy-ff-"));
const rr = path.join(dir, "rr.json");
const baseConfig = {
  tavilyApiKeys: ["tvly-official"],
  tavilyApiKey: "tvly-official",
  tavilyRoundRobinPath: rr,
  tavilyProxyTimeoutMs: 200,
  retryMaxAttempts: 1,
  retryMaxWait: 0,
  retryMultiplier: 0,
};

const official = await listen((req, res) => {
  req.resume();
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url.endsWith("/search")) {
    res.end(JSON.stringify({ results: [{ url: "https://example.com/official", title: "Official", content: "body" }] }));
    return;
  }
  res.end(JSON.stringify({ results: ["https://example.com/official"], base_url: "https://example.com" }));
});

try {
  const hang = await listen((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
  });
  const started = Date.now();
  const hangOutcome = await tavilySearch("latest AI agent news", 3, {
    ...baseConfig,
    tavilyApiUrl: `http://127.0.0.1:${official.address().port}`,
    tavilyProxyUrl: `http://127.0.0.1:${hang.address().port}`,
    tavilyProxyKey: "th-proxy",
  });
  const elapsed = Date.now() - started;
  hang.close();
  assert.equal(hangOutcome.ok, true, `hang fallback should succeed: ${hangOutcome.error}`);
  assert.equal(hangOutcome.tavily_backend, "official");
  assert.equal(hangOutcome.tavily_proxy_tried, true);
  assert.match(String(hangOutcome.tavily_proxy_error), /超时/);
  assert.equal(hangOutcome.sources?.[0]?.url, "https://example.com/official");
  assert.ok(elapsed < 3000, `proxy hang should fail-fast, took ${elapsed}ms`);

  const empty = await listen((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.endsWith("/search")) res.end(JSON.stringify({ results: [] }));
    else res.end(JSON.stringify({ results: [] }));
  });
  const emptyConfig = {
    ...baseConfig,
    tavilyApiUrl: `http://127.0.0.1:${official.address().port}`,
    tavilyProxyUrl: `http://127.0.0.1:${empty.address().port}`,
    tavilyProxyKey: "th-proxy",
  };
  const emptyOutcome = await tavilySearch("empty query", 3, emptyConfig);
  assert.equal(emptyOutcome.ok, true, `empty proxy should fall back: ${emptyOutcome.error}`);
  assert.equal(emptyOutcome.tavily_backend, "official");
  assert.equal(emptyOutcome.tavily_proxy_tried, true);
  assert.match(String(emptyOutcome.tavily_proxy_error), /空结果/);
  assert.equal(emptyOutcome.sources?.[0]?.url, "https://example.com/official");

  const officialEmpty = await tavilySearch("empty query", 3, {
    ...baseConfig,
    tavilyApiUrl: `http://127.0.0.1:${empty.address().port}`,
  });
  assert.equal(officialEmpty.ok, true, "official empty sources stay ok:true");
  assert.equal(officialEmpty.tavily_backend, "official");
  assert.deepEqual(officialEmpty.sources, []);

  const emptyMap = await tavilyMap(
    "https://example.com",
    { maxDepth: 1, maxBreadth: 20, limit: 10, timeout: 1 },
    emptyConfig
  );
  assert.equal(emptyMap.ok, true, `empty proxy map should fall back: ${emptyMap.error}`);
  assert.equal(emptyMap.tavily_backend, "official");
  assert.equal(emptyMap.tavily_proxy_tried, true);
  assert.match(String(emptyMap.tavily_proxy_error), /空结果/);
  assert.deepEqual(emptyMap.results, ["https://example.com/official"]);
  empty.close();

  console.log("tavily-proxy-failfast.test.js: ok");
} finally {
  official.close();
  rmSync(dir, { recursive: true, force: true });
}
