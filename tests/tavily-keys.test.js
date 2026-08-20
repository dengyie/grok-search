#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveTavilyApiKeys } from "../scripts/lib/config.js";
import {
  isTavilyKeyExhaustedError,
  loadTavilyRoundRobinIndex,
  nextTavilyApiKey,
  saveTavilyRoundRobinIndex,
  withTavilyApiKey,
} from "../scripts/lib/providers.js";

function noEnv() {
  return undefined;
}

// --- resolveTavilyApiKeys ---
assert.deepEqual(
  resolveTavilyApiKeys({ tavilyApiKeys: [], tavilyApiKey: "tvly-real" }, noEnv),
  ["tvly-real"],
  "empty tavilyApiKeys must not swallow tavilyApiKey"
);

assert.deepEqual(
  resolveTavilyApiKeys({ tavilyApiKey: "tvly-real" }, noEnv),
  ["tvly-real"]
);

assert.deepEqual(
  resolveTavilyApiKeys({ tavilyApiKeys: ["a", "b"], tavilyApiKey: "c" }, noEnv),
  ["a", "b", "c"],
  "file multi + single merge"
);

assert.deepEqual(
  resolveTavilyApiKeys({ tavilyApiKeys: ["a", "a", "b"] }, noEnv),
  ["a", "b"]
);

assert.deepEqual(
  resolveTavilyApiKeys({ tavilyApiKeys: ["file-a"], tavilyApiKey: "file-b" }, (name) =>
    name === "TAVILY_API_KEYS" ? "env-1,env-2" : undefined
  ),
  ["env-1", "env-2"],
  "env multi wins over file"
);

assert.deepEqual(
  resolveTavilyApiKeys({ tavilyApiKeys: ["file-a"] }, (name) =>
    name === "TAVILY_API_KEY" ? "env-single" : undefined
  ),
  ["env-single"],
  "env single wins over file"
);

// --- isTavilyKeyExhaustedError ---
assert.equal(isTavilyKeyExhaustedError({ status: 401, message: "HTTP 401: no" }), true);
assert.equal(isTavilyKeyExhaustedError({ status: 402, message: "payment required" }), true);
assert.equal(isTavilyKeyExhaustedError({ status: 403, message: "HTTP 403: forbidden by WAF" }), false);
assert.equal(isTavilyKeyExhaustedError({ status: 403, message: "HTTP 403: invalid api key" }), true);
assert.equal(isTavilyKeyExhaustedError({ status: 429, message: "rate limit please slow down" }), true);
assert.equal(isTavilyKeyExhaustedError({ status: 429, message: "too many requests" }), false);
assert.equal(isTavilyKeyExhaustedError({ message: "HTTP 402: credits exhausted" }), true);
assert.equal(isTavilyKeyExhaustedError({ message: "empty body" }), false);

// --- persistent RR across nextTavilyApiKey claims ---
const dir = mkdtempSync(path.join(tmpdir(), "grok-search-rr-"));
const rrPath = path.join(dir, "tavily-rr.json");
const cfg = {
  tavilyApiKeys: ["k0", "k1", "k2"],
  tavilyRoundRobinPath: rrPath,
};

const claimed = [];
for (let i = 0; i < 5; i += 1) {
  claimed.push(nextTavilyApiKey(cfg).index);
}
assert.deepEqual(claimed, [0, 1, 2, 0, 1], "persistent RR order");

const stored = JSON.parse(readFileSync(rrPath, "utf8"));
assert.equal(loadTavilyRoundRobinIndex(3, cfg), stored.nextIndex % 3);

// --- withTavilyApiKey failover on quota ---
saveTavilyRoundRobinIndex(0, cfg); // reset start to 0
const seen = [];
const outcome = await withTavilyApiKey(cfg, async (apiKey, index) => {
  seen.push(index);
  if (index === 0) {
    const err = new Error("HTTP 402: credits exhausted");
    err.status = 402;
    throw err;
  }
  return { ok: true, provider: "tavily", sources: [{ url: "https://example.com" }] };
});
assert.equal(outcome.ok, true);
assert.equal(outcome.tavily_key_index, 1);
assert.deepEqual(seen, [0, 1], "failover from key0 to key1");
assert.equal(outcome.tavily_keys_tried, 2);

// non-quota error should not rotate
saveTavilyRoundRobinIndex(0, cfg);
const seen2 = [];
const fail = await withTavilyApiKey(cfg, async (apiKey, index) => {
  seen2.push(index);
  const err = new Error("HTTP 500: boom");
  err.status = 500;
  throw err;
});
assert.equal(fail.ok, false);
assert.deepEqual(seen2, [0], "non-quota errors must not scan all keys");

rmSync(dir, { recursive: true, force: true });
console.log("tavily-keys.test.js: ok");
