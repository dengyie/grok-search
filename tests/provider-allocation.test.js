import assert from "node:assert";

// Mock config factory
function mockConfig(opts = {}) {
  return {
    providerWeights: opts.weights || undefined,
    tavilyApiKey: opts.tavilyKey || undefined,
    tavilyApiKeys: opts.tavilyKeys || undefined,
    firecrawlApiKey: opts.firecrawlKey || undefined,
    firecrawlApiUrl: opts.firecrawlUrl || undefined,
    fathomApiKey: opts.fathomKey || undefined,
    mcpTavilyToken: opts.mcpTavilyToken || undefined,
  };
}

// Minimal implementations of helper functions from providers.js
function allTavilyKeys(config) {
  if (Array.isArray(config?.tavilyApiKeys) && config.tavilyApiKeys.length) {
    return config.tavilyApiKeys.map((k) => String(k || "").trim()).filter(Boolean);
  }
  if (typeof config?.tavilyApiKey === "string" && config.tavilyApiKey.trim()) {
    return [config.tavilyApiKey.trim()];
  }
  return [];
}

function hasTavilyApiKey(config) {
  return allTavilyKeys(config).length > 0;
}

function hasFathomApiKey(config) {
  return typeof config?.fathomApiKey === "string" && config.fathomApiKey.trim().length > 0;
}

function hasMcpTavilyConfig(config) {
  return typeof config?.mcpTavilyToken === "string" && config.mcpTavilyToken.trim().length > 0;
}

// Extracted from search.js
function providerWeight(weights, name, fallback) {
  const value = weights?.[name];
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function extraAllocation(limit, config) {
  if (limit <= 0) return { tavily: 0, firecrawl: 0, fathom: 0, mcpTavily: 0 };

  const weights = config?.providerWeights || {};
  const providers = [];

  if (hasTavilyApiKey(config)) {
    providers.push({ name: "tavily", weight: providerWeight(weights, "tavily", 25) });
  }
  if (config?.firecrawlApiKey || config?.firecrawlApiUrl) {
    providers.push({ name: "firecrawl", weight: providerWeight(weights, "firecrawl", 25) });
  }
  if (hasFathomApiKey(config)) {
    providers.push({ name: "fathom", weight: providerWeight(weights, "fathom", 25) });
  }
  if (hasMcpTavilyConfig(config)) {
    providers.push({ name: "mcpTavily", weight: providerWeight(weights, "mcpTavily", 25) });
  }

  if (providers.length === 0) return { tavily: 0, firecrawl: 0, fathom: 0, mcpTavily: 0 };

  let totalWeight = providers.reduce((sum, p) => sum + p.weight, 0);
  if (totalWeight <= 0) {
    for (const p of providers) p.weight = 1;
    totalWeight = providers.length;
  }
  const allocation = { tavily: 0, firecrawl: 0, fathom: 0, mcpTavily: 0 };
  let allocated = 0;

  for (let i = 0; i < providers.length - 1; i++) {
    const count = Math.round((limit * providers[i].weight) / totalWeight);
    allocation[providers[i].name] = count;
    allocated += count;
  }

  allocation[providers[providers.length - 1].name] = limit - allocated;

  return allocation;
}

// Test suite
console.log("Running provider-allocation.test.js...\n");

// Test 1: Zero limit
(() => {
  const config = mockConfig({ tavilyKey: "key1" });
  const result = extraAllocation(0, config);
  assert.deepStrictEqual(result, { tavily: 0, firecrawl: 0, fathom: 0, mcpTavily: 0 });
  console.log("✓ Zero limit returns all zeros");
})();

// Test 2: Single provider (Tavily only)
(() => {
  const config = mockConfig({ tavilyKey: "key1" });
  const result = extraAllocation(10, config);
  assert.strictEqual(result.tavily, 10);
  assert.strictEqual(result.firecrawl, 0);
  assert.strictEqual(result.fathom, 0);
  assert.strictEqual(result.mcpTavily, 0);
  console.log("✓ Single provider gets full allocation");
})();

// Test 3: Equal weights (default); mcpTavily configured too
(() => {
  const config = mockConfig({
    tavilyKey: "key1",
    firecrawlUrl: "http://fc",
    fathomKey: "fk1",
    mcpTavilyToken: "tok1",
  });
  const result = extraAllocation(6, config);
  const total = result.tavily + result.firecrawl + result.fathom + result.mcpTavily;
  assert.strictEqual(total, 6);
  console.log(
    `✓ Equal weights with limit=6: tavily=${result.tavily}, firecrawl=${result.firecrawl}, fathom=${result.fathom}, mcpTavily=${result.mcpTavily}`
  );
})();

// Test 4: Custom weights incl. mcpTavily
(() => {
  const config = mockConfig({
    tavilyKey: "key1",
    firecrawlUrl: "http://fc",
    fathomKey: "fk1",
    mcpTavilyToken: "tok1",
    weights: { tavily: 40, firecrawl: 30, fathom: 20, mcpTavily: 10 },
  });
  const result = extraAllocation(10, config);
  const total = result.tavily + result.firecrawl + result.fathom + result.mcpTavily;
  assert.strictEqual(total, 10);
  assert.ok(result.tavily >= result.firecrawl);
  assert.ok(result.firecrawl >= result.fathom);
  assert.ok(result.fathom >= result.mcpTavily);
  console.log(
    `✓ Custom weights 40:30:20:10 with limit=10: tavily=${result.tavily}, firecrawl=${result.firecrawl}, fathom=${result.fathom}, mcpTavily=${result.mcpTavily}`
  );
})();

// Test 4b: mcpTavily-only gets full allocation
(() => {
  const config = mockConfig({ mcpTavilyToken: "tok1" });
  const result = extraAllocation(5, config);
  assert.strictEqual(result.mcpTavily, 5);
  assert.strictEqual(result.tavily, 0);
  assert.strictEqual(result.firecrawl, 0);
  assert.strictEqual(result.fathom, 0);
  console.log("✓ mcpTavily-only via token gets full allocation");
})();

// Test 5: Explicit zero weight for one provider zeros it out
(() => {
  const config = mockConfig({
    tavilyKey: "key1",
    firecrawlUrl: "http://fc",
    fathomKey: "fk1",
    weights: { tavily: 50, firecrawl: 50, fathom: 0 },
  });
  const result = extraAllocation(10, config);
  assert.strictEqual(result.fathom, 0);
  const total = result.tavily + result.firecrawl + result.fathom;
  assert.strictEqual(total, 10);
  console.log(`✓ Explicit zero weight zeros out fathom: tavily=${result.tavily}, firecrawl=${result.firecrawl}, fathom=${result.fathom}`);
})();

// Test 5b: All-explicit-zero weights degrade to equal shares (no NaN)
(() => {
  const config = mockConfig({
    tavilyKey: "key1",
    firecrawlUrl: "http://fc",
    fathomKey: "fk1",
    mcpTavilyToken: "tok1",
    weights: { tavily: 0, firecrawl: 0, fathom: 0, mcpTavily: 0 },
  });
  const result = extraAllocation(8, config);
  assert.ok(Number.isFinite(result.tavily));
  assert.ok(Number.isFinite(result.firecrawl));
  assert.ok(Number.isFinite(result.fathom));
  assert.ok(Number.isFinite(result.mcpTavily));
  const total = result.tavily + result.firecrawl + result.fathom + result.mcpTavily;
  assert.strictEqual(total, 8);
  console.log(
    `✓ All-zero weights fall back to equal shares: tavily=${result.tavily}, firecrawl=${result.firecrawl}, fathom=${result.fathom}, mcpTavily=${result.mcpTavily}`
  );
})();

// Test 6: Uneven ratio with odd limit
(() => {
  const config = mockConfig({
    tavilyKey: "key1",
    firecrawlUrl: "http://fc",
    weights: { tavily: 2, firecrawl: 1 },
  });
  const result = extraAllocation(7, config);
  const total = result.tavily + result.firecrawl;
  assert.strictEqual(total, 7);
  console.log(`✓ Uneven ratio 2:1 with limit=7: tavily=${result.tavily}, firecrawl=${result.firecrawl}`);
})();

// Test 7: No providers configured
(() => {
  const config = mockConfig();
  const result = extraAllocation(10, config);
  assert.deepStrictEqual(result, { tavily: 0, firecrawl: 0, fathom: 0, mcpTavily: 0 });
  console.log("✓ No providers returns all zeros");
})();

// Test 8: Large limit with all four providers
(() => {
  const config = mockConfig({
    tavilyKey: "key1",
    firecrawlUrl: "http://fc",
    fathomKey: "fk1",
    mcpTavilyToken: "tok1",
  });
  const result = extraAllocation(100, config);
  const total = result.tavily + result.firecrawl + result.fathom + result.mcpTavily;
  assert.strictEqual(total, 100);
  console.log(
    `✓ Large limit=100: tavily=${result.tavily}, firecrawl=${result.firecrawl}, fathom=${result.fathom}, mcpTavily=${result.mcpTavily}`
  );
})();

// Test 9: Firecrawl only (no key, but URL present)
(() => {
  const config = mockConfig({ firecrawlUrl: "http://fc" });
  const result = extraAllocation(5, config);
  assert.strictEqual(result.firecrawl, 5);
  assert.strictEqual(result.tavily, 0);
  assert.strictEqual(result.fathom, 0);
  assert.strictEqual(result.mcpTavily, 0);
  console.log("✓ Firecrawl-only via URL gets full allocation");
})();

console.log("\n✅ All provider-allocation tests passed");
