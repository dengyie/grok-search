import assert from "node:assert";

// Mock implementations
function mockConfig(opts = {}) {
  return {
    tavilyApiKey: opts.tavilyKey || undefined,
    firecrawlApiKey: opts.firecrawlKey || undefined,
    fathomApiKey: opts.fathomKey || undefined,
    grokApiKey: opts.grokKey || undefined,
  };
}

// Status determination logic from search.js
function determineStatus(grokSuccess, grokQuotaExhausted, extraAttempts) {
  const extraSuccess = extraAttempts.some((a) => a.success);
  const extraPartialSuccess = extraAttempts.length > 0 && extraAttempts.some((a) => a.success);
  const allExtraFailed = extraAttempts.length > 0 && extraAttempts.every((a) => !a.success);

  if (grokSuccess && (extraAttempts.length === 0 || extraAttempts.every((a) => a.success))) {
    return "success";
  }
  if (grokSuccess && extraPartialSuccess) {
    return "partial_success";
  }
  if (grokQuotaExhausted && extraSuccess) {
    return "degraded_success";
  }
  return "total_failure";
}

// Test suite
console.log("Running provider-status.test.js...\n");

// Test 1: Full success (Grok + all extras)
(() => {
  const status = determineStatus(
    true,
    false,
    [
      { provider: "tavily", success: true },
      { provider: "firecrawl", success: true },
    ]
  );
  assert.strictEqual(status, "success");
  console.log("✓ Full success: Grok + all extras succeed");
})();

// Test 2: Partial success (Grok + some extras fail)
(() => {
  const status = determineStatus(
    true,
    false,
    [
      { provider: "tavily", success: true },
      { provider: "firecrawl", success: false },
      { provider: "fathom", success: false },
    ]
  );
  assert.strictEqual(status, "partial_success");
  console.log("✓ Partial success: Grok succeeds, some extras fail");
})();

// Test 3: Degraded success (Grok quota exhausted but extras work)
(() => {
  const status = determineStatus(
    false,
    true,
    [
      { provider: "tavily", success: true },
      { provider: "firecrawl", success: true },
    ]
  );
  assert.strictEqual(status, "degraded_success");
  console.log("✓ Degraded success: Grok quota exhausted, extras provide results");
})();

// Test 4: Total failure (all providers fail)
(() => {
  const status = determineStatus(
    false,
    false,
    [
      { provider: "tavily", success: false },
      { provider: "firecrawl", success: false },
    ]
  );
  assert.strictEqual(status, "total_failure");
  console.log("✓ Total failure: all providers fail");
})();

// Test 5: Grok-only success (no extras configured)
(() => {
  const status = determineStatus(true, false, []);
  assert.strictEqual(status, "success");
  console.log("✓ Grok-only success: no extras configured");
})();

// Test 6: Grok fails, no extras to fall back
(() => {
  const status = determineStatus(false, false, []);
  assert.strictEqual(status, "total_failure");
  console.log("✓ Grok-only failure: no extras to provide fallback");
})();

// Test 7: Degraded with partial extras
(() => {
  const status = determineStatus(
    false,
    true,
    [
      { provider: "tavily", success: true },
      { provider: "firecrawl", success: false },
    ]
  );
  assert.strictEqual(status, "degraded_success");
  console.log("✓ Degraded success: Grok quota exhausted, at least one extra works");
})();

// Test 8: Grok quota exhausted + all extras fail
(() => {
  const status = determineStatus(
    false,
    true,
    [
      { provider: "tavily", success: false },
      { provider: "firecrawl", success: false },
    ]
  );
  assert.strictEqual(status, "total_failure");
  console.log("✓ Total failure: Grok quota exhausted and all extras fail");
})();

console.log("\n✅ All provider-status tests passed");
