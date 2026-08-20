#!/usr/bin/env node
// Regression guard: requestJson must not `throw undefined` when config
// lacks `retryMaxAttempts`. Root cause found while wiring up the noUsable
// E2E test: `const maxAttempts = retry ? config.retryMaxAttempts : 1` meant a
// config without that key yielded `for (attempt=0; attempt < undefined ...)`
// which never ran the loop → `throw lastError` where lastError is undefined.
// Fix: retryMaxAttempts(config) falls back to DEFAULT_RETRY_MAX_ATTEMPTS (3).
//
// We exercise the fallback by calling requestJson with retry:true against a
// mock endpoint that always HTTP-500s. With the fix, the function must reject
// with the last upstream error (not `undefined`) after attempting the default
// number of times, and each attempt must actually dispatch a request.

import assert from "node:assert/strict";
import { createServer } from "node:http";

const DEFAULT_RETRY_MAX_ATTEMPTS = 3;

async function main() {
  let server;
  try {
    let hits = 0;
    server = createServer((_req, res) => {
      hits += 1;
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream exploded" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;

    const { requestJson } = await import("../scripts/lib/providers.js");

    // No retryMaxAttempts in config → must NOT throw undefined; tries 3 times (default).
    await assert.rejects(
      () =>
        requestJson(url, {
          headers: { "content-type": "application/json" },
          body: { q: "x" },
          timeoutMs: 1000,
          config: { firecrawlApiUrl: url }, // note: no retryMaxAttempts key
          retry: true,
        }),
      (err) => {
        assert.ok(err instanceof Error, `expected an Error, got: ${String(err)}`);
        assert.match(err.message, /HTTP 500/, `unexpected error message: ${err.message}`);
        return true;
      }
    );
    assert.equal(hits, DEFAULT_RETRY_MAX_ATTEMPTS, `expected ${DEFAULT_RETRY_MAX_ATTEMPTS} dispatch attempts, got ${hits}`);

    // backoffMs must not produce NaN just because retryMultiplier/retryMaxWait
    // are absent from the config.
    const { backoffMs } = await import("../scripts/lib/providers.js");
    for (const attemptIndex of [0, 1, 2]) {
      const ms = backoffMs({}, attemptIndex); // empty config → missing retry keys
      assert.ok(Number.isFinite(ms) && ms >= 0, `backoffMs({}, ${attemptIndex}) = ${ms}, expected finite >= 0`);
    }

    console.log(`✓ requestJson without retryMaxAttempts falls back to ${DEFAULT_RETRY_MAX_ATTEMPTS} attempts, no throw undefined`);
    console.log("✓ backoffMs with missing retry config stays finite");
    console.log("\n✅ request-json-fallback tests passed");
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    server?.close?.();
  }
}

main();