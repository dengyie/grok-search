#!/usr/bin/env node
// Proxy fail-fast: a hanging third-party Tavily must not consume the official
// retry budget. Proxy search with HTTP 200 + empty sources must fall back.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { tavilySearch } from "../scripts/lib/providers.js";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function origin(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

async function main() {
  let hangServer;
  let officialServer;
  const dir = mkdtempSync(path.join(tmpdir(), "grok-search-proxy-ff-"));
  try {
    hangServer = createServer((_req, _res) => {
      // Intentionally never respond — AbortController must win.
    });
    officialServer = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url?.includes("/search")) {
          res.end(
            JSON.stringify({
              results: [{ url: "https://example.com/official", title: "Official", content: "ok" }],
            })
          );
          return;
        }
        res.end(JSON.stringify({ results: [] }));
      });
    });
    await Promise.all([listen(hangServer), listen(officialServer)]);

    const hangUrl = origin(hangServer);
    const officialUrl = origin(officialServer);
    const started = Date.now();
    const hangOutcome = await tavilySearch("latest AI agent news", 3, {
      tavilyProxyUrl: hangUrl,
      tavilyProxyKey: "th-proxy",
      tavilyProxyTimeoutMs: 400,
      tavilyApiUrl: officialUrl,
      tavilyApiKeys: ["tvly-official"],
      tavilyRoundRobinPath: path.join(dir, "hang-rr.json"),
    });
    const elapsed = Date.now() - started;

    assert.equal(hangOutcome.ok, true, `hang fallback should succeed: ${hangOutcome.error}`);
    assert.equal(hangOutcome.tavily_backend, "official");
    assert.equal(hangOutcome.tavily_proxy_tried, true);
    assert.match(String(hangOutcome.tavily_proxy_error), /超时/);
    assert.equal(hangOutcome.sources?.[0]?.url, "https://example.com/official");
    assert.ok(elapsed < 3000, `proxy hang should fail-fast, took ${elapsed}ms`);

    const emptyProxy = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });
    await listen(emptyProxy);
    try {
      const emptyOutcome = await tavilySearch("empty query", 3, {
        tavilyProxyUrl: origin(emptyProxy),
        tavilyProxyKey: "th-proxy",
        tavilyProxyTimeoutMs: 2000,
        tavilyApiUrl: officialUrl,
        tavilyApiKeys: ["tvly-official"],
        tavilyRoundRobinPath: path.join(dir, "empty-rr.json"),
      });
      assert.equal(emptyOutcome.ok, true, `empty proxy should fall back: ${emptyOutcome.error}`);
      assert.equal(emptyOutcome.tavily_backend, "official");
      assert.equal(emptyOutcome.tavily_proxy_tried, true);
      assert.match(String(emptyOutcome.tavily_proxy_error), /空结果/);
      assert.equal(emptyOutcome.sources?.[0]?.url, "https://example.com/official");

      const officialEmpty = await tavilySearch("empty query", 3, {
        tavilyApiUrl: origin(emptyProxy),
        tavilyApiKeys: ["tvly-official"],
        tavilyRoundRobinPath: path.join(dir, "official-empty-rr.json"),
      });
      assert.equal(officialEmpty.ok, true, "official empty sources stay ok:true");
      assert.equal(officialEmpty.tavily_backend, "official");
      assert.deepEqual(officialEmpty.sources, []);
    } finally {
      emptyProxy.close();
    }

    console.log("tavily-proxy-failfast.test.js: ok");
  } finally {
    hangServer?.close();
    officialServer?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
