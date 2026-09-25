#!/usr/bin/env node
// requestJson must not `throw undefined` when config lacks retryMaxAttempts.
// `const maxAttempts = retry ? config.retryMaxAttempts : 1` made a missing key
// produce `for (attempt = 0; attempt < undefined)`, so the loop never ran and
// the thrown value was undefined. retryMaxAttempts() falls back to 3.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { backoffMs, requestJson } from "../scripts/lib/providers.js";

const DEFAULT_RETRY_MAX_ATTEMPTS = 3;

const server = createServer((_req, res) => {
  hits += 1;
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "upstream exploded" }));
});
let hits = 0;
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
  const url = `http://127.0.0.1:${server.address().port}/`;
  await assert.rejects(
    () =>
      requestJson(url, {
        headers: { "content-type": "application/json" },
        body: { q: "x" },
        timeoutMs: 1000,
        config: { retryMaxWait: 0, retryMultiplier: 0 },
        retry: true,
      }),
    (err) => {
      assert.ok(err instanceof Error, `expected an Error, got: ${String(err)}`);
      assert.match(err.message, /HTTP 500/);
      return true;
    }
  );
  assert.equal(hits, DEFAULT_RETRY_MAX_ATTEMPTS);

  for (const attemptIndex of [0, 1, 2]) {
    const ms = backoffMs({}, attemptIndex);
    assert.ok(Number.isFinite(ms) && ms >= 0, `backoffMs({}, ${attemptIndex}) = ${ms}`);
  }
  assert.equal(backoffMs({ retryMaxWait: undefined, retryMultiplier: undefined }, 0), 1000);

  console.log("request-json-fallback.test.js: ok");
} finally {
  server.close();
}
