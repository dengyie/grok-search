#!/usr/bin/env node
// E2E regression guard for the "noUsable" branch in scripts/search.js.
//
// noUsable triggers when Grok Responses returns 200 with output text but NO usable
// URL cards (GROK_RESPONSES_NO_SOURCES / GROK_RESPONSES_EMPTY — a stateless echo
// from the proxy layer). search.js must then NOT throw; instead it must:
//   - set degraded:true, grok_error.code = GROK_NO_USABLE
//   - report status "degraded_success" when extra providers contributed sources,
//     "total_failure" when they did not.
//
// The real publicResult() from scripts/search.js is imported and driven through a
// local in-process mock HTTP server via a hand-built hermetic config (no real
// provider tokens, no real network). We do not spawn a child process because the
// sandbox blocks subprocess→parent-localhost networking, which would silently fall
// back to the real Tavily/OpenAI endpoints.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";

function createMockServer() {
  return createServer((req, res) => {
    if (req.url?.includes("/tavily/search")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            { url: "https://example.com/ai-news", title: "AI News Aug 2026", content: "A project releases a model." },
          ],
        })
      );
      return;
    }
    // Everything else is the Responses endpoint: stateless echo, no source cards.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        output_text: "A stateless echo of training knowledge with no source cards.",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "X" }] }],
      })
    );
  });
}

// A hermetic config: only Tavily is configured, pointed at the local mock. Nothing
// in this object routes to a real network host.
function hermeticConfig(tavilyApiUrl, outputDir) {
  return {
    grokApiUrl: tavilyApiUrl.replace(/\/tavily/, "/grok"),
    grokApiKey: "test-grok-key",
    apiProvider: "openai-compatible",
    grokModel: "grok-4.3",
    responsesMaxTurns: 3,
    responsesReasoningEffort: "low",
    responsesAllowedDomains: [],
    responsesExcludedDomains: [],
    responsesIncludeXSearch: false,
    responsesAllowedXHandles: [],
    responsesExcludedXHandles: [],
    responsesOpenRouterEngine: "auto",
    tavilyApiUrl, // e.g. http://127.0.0.1:PORT/tavily
    tavilyApiKeys: ["test-tavily-key"],
    tavilyApiKey: "test-tavily-key",
    firecrawlApiUrl: "",
    firecrawlApiKey: "",
    fathomApiKey: "",
    fathomApiUrl: "",
    mcpTavilyUrl: "",
    mcpTavilyToken: "",
    defaultExtra: 6,
    providerWeights: {},
    retryMaxAttempts: 3, // explicit; requestJson also falls back to DEFAULT_RETRY_MAX_ATTEMPTS if absent
    outputDir,
    outputRetentionDays: 30,
  };
}

async function main() {
  let server;
  try {
    server = createMockServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;

    const { publicResult } = await import("../scripts/search.js");
    const config = hermeticConfig(`${base}/tavily`, tmpdir());

    // Case 1: grok returns no usable sources, Tavily returns results → degraded_success.
    await assert.doesNotReject(async () => {
      const res = await publicResult(
        { query: "state of AI", extra: 1, extraMode: "explicit" },
        config
      );
      assert.equal(res.diagnostics.status, "degraded_success", `expected degraded_success, got ${res.diagnostics.status}`);
      assert.equal(res.diagnostics.degraded, true, "degraded flag should be set");
      assert.equal(res.diagnostics.grok_error?.code, "GROK_NO_USABLE", `grok_error.code: ${JSON.stringify(res.diagnostics.grok_error)}`);
      assert.equal(res.sources.grok.length, 0, "grok compact sources should be empty");
      const urls = res.sources.merged.map((s) => s.url);
      assert.ok(urls.includes("https://example.com/ai-news"), `merged missing Tavily URL: ${urls.join(",")}`);
    }, "case 1 should not reject");
    console.log("✓ noUsable + Tavily → degraded_success (degraded, GROK_NO_USABLE, extra preserved)");

    // Case 2: noUsable + --no-extra (extra disabled) → total_failure, but still degrades.
    await assert.doesNotReject(async () => {
      const res = await publicResult({ query: "state of AI", extra: 0, extraMode: "off" }, config);
      assert.equal(res.diagnostics.status, "total_failure", `case2 expected total_failure, got ${res.diagnostics.status}`);
      assert.equal(res.diagnostics.degraded, true, "case2 should be degraded");
      assert.equal(res.diagnostics.grok_error?.code, "GROK_NO_USABLE", `case2 grok_error.code: ${JSON.stringify(res.diagnostics.grok_error)}`);
      assert.equal(res.sources.extra.length, 0, "case2 extras should be empty");
    }, "case 2 should not reject");
    console.log("✓ noUsable + --no-extra → total_failure (degraded, no throw)");

    console.log("\n✅ All no-usable e2e tests passed");
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    server?.close?.();
  }
}

main();