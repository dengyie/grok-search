import assert from "node:assert";
import { sourceFromTavily } from "../scripts/lib/providers.js";

// Regression: sourceFromTavily's provider default must survive real call patterns.
// tavilySearch calls it as `.map((result) => sourceFromTavily(result))` and
// mcpTavilySearch as `.map((result) => sourceFromTavily(result, "mcpTavily"))`.
// A prior version of the function relied on the bare `.map(sourceFromTavily)` form,
// which passes the array index as the second arg and tagged every Tavily result
// "unknown". Guard the default here so that can't silently regress.
const SAMPLE = { url: "https://example.com/a", title: "A", content: "body", published_date: "2026-08-01", score: 0.9 };

console.log("Running tavily-tagging.test.js...\n");

// Default provider (tavilySearch call pattern)
const tavilyTagged = sourceFromTavily(SAMPLE);
assert.strictEqual(tavilyTagged.provider, "tavily");
assert.strictEqual(tavilyTagged.title, "A");
assert.strictEqual(tavilyTagged.description, "body");
assert.strictEqual(tavilyTagged.published_date, "2026-08-01");
assert.strictEqual(tavilyTagged.score, 0.9);
console.log("✓ sourceFromTavily(result) tags provider 'tavily' by default");

// Explicit provider (mcpTavilySearch call pattern)
const mcpTagged = sourceFromTavily(SAMPLE, "mcpTavily");
assert.strictEqual(mcpTagged.provider, "mcpTavily");
console.log("✓ Explicit provider override tags results as 'mcpTavily'");

assert.strictEqual(sourceFromTavily({ url: " " }), null);
assert.strictEqual(sourceFromTavily({}), null);
console.log("✓ Missing/blank URL returns null");

console.log("\n✅ All tavily-tagging tests passed");
