import assert from "node:assert";

// Mock implementations
function mockConfig(opts = {}) {
  return {
    tavilyApiKey: opts.tavilyKey || undefined,
    firecrawlApiKey: opts.firecrawlKey || undefined,
    fathomApiKey: opts.fathomKey || undefined,
    grokApiKey: opts.grokKey || undefined,
    apiProvider: opts.apiProvider || "xai",
  };
}

// Extracted from search.js
function responsesDiagnosticOptions() {
  return {};
}

function failureDiagnostics(config, searchOptions, extraOptions, extra, error, { quota = false } = {}) {
  const warning = quota
    ? "Grok Responses quota was exhausted."
    : `Responses search failed: ${error.message}`;
  const rateLimited = error?.status === 429;
  return {
    grok_endpoint: "responses",
    ...(quota ? { grok_error: { code: "QUOTA_EXHAUSTED", message: error.message } } : {}),
    ...(rateLimited ? { rate_limited: true } : {}),
    warnings: [warning, ...(extra?.warnings || []), ...(error?.diagnostics?.warnings || [])],
    provider_attempts: [],
    options: {
      api_provider: config.apiProvider,
      extra: extraOptions.limit,
      extra_mode: extraOptions.mode,
      extra_allocation: extra?.allocation || { tavily: 0, firecrawl: 0, fathom: 0, mcpTavily: 0 },
      firecrawl_auth_mode: null,
      ...responsesDiagnosticOptions(searchOptions),
    },
  };
}

// Test suite
console.log("Running rate-limited.test.js...\n");

// Test 1: 429 status code sets rate_limited flag
(() => {
  const config = mockConfig({ grokKey: "test-key" });
  const error = new Error("Rate limit exceeded");
  error.status = 429;
  const result = failureDiagnostics(
    config,
    {},
    { limit: 0, mode: "parallel" },
    { allocation: { tavily: 0, firecrawl: 0, fathom: 0 } },
    error,
    { quota: false }
  );
  assert.strictEqual(result.rate_limited, true);
  console.log("✓ 429 status code sets rate_limited: true");
})();

// Test 2: Non-429 error does not set rate_limited flag
(() => {
  const config = mockConfig({ grokKey: "test-key" });
  const error = new Error("Server error");
  error.status = 500;
  const result = failureDiagnostics(
    config,
    {},
    { limit: 0, mode: "parallel" },
    { allocation: { tavily: 0, firecrawl: 0, fathom: 0 } },
    error,
    { quota: false }
  );
  assert.strictEqual(result.rate_limited, undefined);
  console.log("✓ Non-429 status code does not set rate_limited flag");
})();

// Test 3: Quota exhaustion with 429 sets both flags
(() => {
  const config = mockConfig({ grokKey: "test-key" });
  const error = new Error("Quota exceeded");
  error.status = 429;
  const result = failureDiagnostics(
    config,
    {},
    { limit: 0, mode: "parallel" },
    { allocation: { tavily: 0, firecrawl: 0, fathom: 0 } },
    error,
    { quota: true }
  );
  assert.strictEqual(result.rate_limited, true);
  assert.strictEqual(result.grok_error.code, "QUOTA_EXHAUSTED");
  console.log("✓ Quota exhaustion with 429 sets both rate_limited and grok_error");
})();

// Test 4: Quota exhaustion with 402 does not set rate_limited
(() => {
  const config = mockConfig({ grokKey: "test-key" });
  const error = new Error("Payment required");
  error.status = 402;
  const result = failureDiagnostics(
    config,
    {},
    { limit: 0, mode: "parallel" },
    { allocation: { tavily: 0, firecrawl: 0, fathom: 0 } },
    error,
    { quota: true }
  );
  assert.strictEqual(result.rate_limited, undefined);
  assert.strictEqual(result.grok_error.code, "QUOTA_EXHAUSTED");
  console.log("✓ Quota exhaustion with 402 sets grok_error but not rate_limited");
})();

// Test 5: Error without status code does not set rate_limited
(() => {
  const config = mockConfig({ grokKey: "test-key" });
  const error = new Error("Network error");
  const result = failureDiagnostics(
    config,
    {},
    { limit: 0, mode: "parallel" },
    { allocation: { tavily: 0, firecrawl: 0, fathom: 0 } },
    error,
    { quota: false }
  );
  assert.strictEqual(result.rate_limited, undefined);
  console.log("✓ Error without status code does not set rate_limited flag");
})();

console.log("\n✅ All rate-limited tests passed");
