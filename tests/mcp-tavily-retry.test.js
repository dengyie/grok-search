import assert from "node:assert";
import { isTransientMcpTavilyError } from "../scripts/lib/providers.js";

console.log("Running mcp-tavily-retry.test.js...\n");

// Transient transport failures -> should retry.
function undiciError(message, code) {
  return Object.assign(new Error(message), { cause: Object.assign(new Error(`${message} cause`), { code }) });
}

assert.strictEqual(isTransientMcpTavilyError(undiciError("fetch failed", "ECONNRESET")), true);
assert.strictEqual(isTransientMcpTavilyError(undiciError("fetch failed", "ECONNREFUSED")), true);
assert.strictEqual(isTransientMcpTavilyError(undiciError("fetch failed", "EAI_AGAIN")), true);
assert.strictEqual(isTransientMcpTavilyError(new Error("socket hang up")), true);
console.log("✓ Transient transport errors (ECONNRESET / ECONNREFUSED / EAI_AGAIN / socket hang up) are retried");

// The 60s timeout message must NOT be retried (retrying a hang would double latency).
assert.strictEqual(isTransientMcpTavilyError(new Error("MCP Tavily 请求超时（>60s）")), false);
console.log("✓ The 60s timeout error is NOT treated as transient (no retry on hang)");

// Protocol / auth / parse errors must NOT be retried.
assert.strictEqual(isTransientMcpTavilyError(new Error("MCP Tavily 返回格式无效")), false);
assert.strictEqual(isTransientMcpTavilyError(new Error("Error -32000: tool not found")), false);
assert.strictEqual(isTransientMcpTavilyError(undiciError("Request failed with status code 401", "HTTP_401")), false);
console.log("✓ Protocol / auth / parse errors are NOT retried");

assert.strictEqual(isTransientMcpTavilyError(null), false);
assert.strictEqual(isTransientMcpTavilyError(undefined), false);
console.log("✓ Null/undefined error is not retried");

console.log("\n✅ All mcp-tavily-retry tests passed");
