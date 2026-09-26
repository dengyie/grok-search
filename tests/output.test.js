#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runRecordBase, writeFullOutput, writeRunRecord, writeRunRecordSync } from "../scripts/lib/output.js";

const outputDir = await mkdtemp(path.join(tmpdir(), "grok-search-output-test-"));
const config = { outputDir, outputRetentionDays: 30 };

// CJK labels all slug to the same fallback; parallel writes in the same second
// must still land in distinct files.
const [first, second] = await Promise.all([
  writeFullOutput(config, { kind: "sources", provider: "search", label: "中文查询一", content: "one" }),
  writeFullOutput(config, { kind: "sources", provider: "search", label: "中文查询二", content: "two" }),
]);
assert.notEqual(first, second);
assert.equal(await readFile(first, "utf8"), "one");
assert.equal(await readFile(second, "utf8"), "two");

if (process.platform !== "win32") {
  assert.equal((await stat(first)).mode & 0o777, 0o600);
  assert.equal((await stat(second)).mode & 0o777, 0o600);
}

// Run records: one JSON per command, named by kind, private, with the schema header.
const base = runRecordBase("search", { grokApiKey: "" }, "2026-09-08T00:00:00.000Z");
assert.equal(base.schema_version, 2);
assert.equal(base.kind, "search");
assert.equal(base.created_at, "2026-09-08T00:00:00.000Z");
assert.equal(Array.isArray(base.argv), true);

const runPath = await writeRunRecord(config, {
  kind: "search",
  label: "run record query",
  record: { ...base, query: "run record query", answer: "full answer", error: null },
});
assert.match(path.basename(runPath), /^grok-search-\d{8}-\d{6}-run-search-run-record-query-[0-9a-f]{6}\.json$/);
if (process.platform !== "win32") assert.equal((await stat(runPath)).mode & 0o777, 0o600);
const stored = JSON.parse(await readFile(runPath, "utf8"));
assert.equal(stored.schema_version, 2);
assert.equal(stored.answer, "full answer");
assert.equal(stored.error, null);

// The synchronous variant (used on the deadline exit path) writes the same shape.
const syncPath = writeRunRecordSync(config, { kind: "fetch", label: "https://example.com/x", record: { ...base, kind: "fetch" } });
assert.match(path.basename(syncPath), /-run-fetch-example-com-x-/);
assert.equal(JSON.parse(await readFile(syncPath, "utf8")).kind, "fetch");

// runLog: false disables both variants without touching the disk.
assert.equal(await writeRunRecord({ ...config, runLog: false }, { kind: "search", label: "off", record: base }), null);
assert.equal(writeRunRecordSync({ ...config, runLog: false }, { kind: "search", label: "off", record: base }), null);

// Secrets pasted into argv are masked in the record header.
const originalArgv = process.argv;
process.argv = ["node", "search.js", "--model", "m", "leak sk-secret-value here"];
try {
  const redacted = runRecordBase("search", { grokApiKey: "sk-secret-value" });
  assert.deepEqual(redacted.argv, ["--model", "m", "leak *** here"]);
} finally {
  process.argv = originalArgv;
}

console.log("output fixtures ok");
