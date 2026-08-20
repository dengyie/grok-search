#!/usr/bin/env node
import assert from "node:assert/strict";
import { filterByRecency, sourcePublishedDate } from "../scripts/lib/sources.js";

// `now` is pinned to mid-day so a 1-day window unambiguously excludes yesterday
// (a midnight `now` would make "yesterday 00:00" land exactly on the cutoff).
const NOW = new Date("2026-07-30T12:00:00Z");

function src(o) {
  return { provider: "tavily", url: o.url || "https://example.com/undated", ...o };
}

// --- sourcePublishedDate: per-field parsing ---------------------------------

let d = sourcePublishedDate(src({ title: "新浪AI热点小时报丨2026年07月30日00时" }));
assert.equal(d && d.toISOString().slice(0, 10), "2026-07-30", "CN full date in title");

d = sourcePublishedDate(src({ title: "2026-07-29 round-up" }));
assert.equal(d && d.toISOString().slice(0, 10), "2026-07-29", "ISO date in title");

d = sourcePublishedDate(src({ title: "2026/07/23 article" }));
assert.equal(d && d.toISOString().slice(0, 10), "2026-07-23", "slash date in title");

d = sourcePublishedDate(src({ published_date: "2026-01-28" }));
assert.equal(d && d.toISOString().slice(0, 10), "2026-01-28", "published_date field wins");

d = sourcePublishedDate(src({ url: "https://www.news.cn/20260128/x.html" }));
assert.equal(d && d.toISOString().slice(0, 10), "2026-01-28", "compact date in URL");

// published_date is consulted before title; a stale published_date should win.
d = sourcePublishedDate(src({ published_date: "2026-03-18", title: "2026-07-30" }));
assert.equal(d && d.toISOString().slice(0, 10), "2026-03-18", "published_date preferred over title");

// Undated sources resolve to null.
assert.equal(sourcePublishedDate(src({ title: "OpenAI News", url: "https://openai.com/news" })), null, "no date -> null");

// Casual CN prose with spaces ("2024 年 3 月 1 日") must still parse.
d = sourcePublishedDate(src({ title: "2024 年 3 月 1 日 AI 周报" }));
assert.equal(d && d.toISOString().slice(0, 10), "2024-03-01", "CN date with spaces parses");

// A stray month-count ("7月 8種工具") must NOT be misread as day 8 — the day
// anchor is a trailing 日, so this is undated, not a fabricated 2026-07-08.
assert.equal(sourcePublishedDate(src({ title: "AI 周報 2026年7月 8種工具" })), null, "CN month-count not misread as date");

// A year-only or year+month title (no 日 / no day) is undated, not day 1.
assert.equal(sourcePublishedDate(src({ title: "2024 年 GitHub star 工具" })), null, "CN year-only with space is undated");

// Year+month only (no day) MUST be treated as undated and kept, not synthesised
// as day 1 — otherwise a current month-scoped title like "2026年7月 最新动态"
// gets mis-dated to 2026-07-01 and wrongly dropped on a tight window.
assert.equal(sourcePublishedDate(src({ title: "2026年7月 最新AI动态" })), null, "year+month only is undated");
assert.equal(sourcePublishedDate(src({ title: "2026-07 月度总结" })), null, "ISO year+month only is undated");
assert.equal(sourcePublishedDate(src({ title: "AI 周刊 2026-07" })), null, "ISO trailing year+month is undated");

// Regression: these month-scoped current titles survive a 2-day window.
const monthScoped = filterByRecency(
  [src({ title: "2026年7月 最新AI动态", url: "https://example.com/july" })],
  { days: 2, now: NOW }
);
assert.equal(monthScoped.sources.length, 1, "month-scoped current title kept within window");
assert.equal(monthScoped.dropped.length, 0, "month-scoped current title not dropped");

// --- filterByRecency: drop old, keep recent and undated ---------------------

const inputs = [
  src({ title: "新浪AI热点小时报丨2026年07月30日00时", url: "https://k.sina.com.cn/30" }),
  src({ title: "新浪AI热点小时报丨2026年07月29日06时", url: "https://k.sina.com.cn/29" }),
  src({ title: "新华深读｜趋势 (2026-01-28)", url: "https://news.cn/1" }),
  src({ title: "🤖 2026年3月18日AI新闻汇总", url: "https://blog.example/3" }),
  src({ title: "OpenAI News", url: "https://openai.com/news" }),
];

const { sources, dropped } = filterByRecency(inputs, { days: 2, now: NOW });
// 1 undated kept + 2 recent kept = 3 kept; 2 old dropped.
assert.equal(sources.length, 3, "keeps recent + undated");
assert.equal(dropped.length, 2, "drops the old two");
assert.equal(dropped[0].url, "https://news.cn/1", "drops January source first");
assert.equal(dropped[1].url, "https://blog.example/3", "drops March source second");
// Undated source survives.
assert.ok(sources.some((s) => s.url === "https://openai.com/news"), "undated source is kept");

// days=0 / invalid -> no filtering, everything returned, nothing dropped.
const passthrough = filterByRecency(inputs, { days: 0, now: NOW });
assert.equal(passthrough.sources.length, inputs.length, "days<=0 passes through");
assert.equal(passthrough.dropped.length, 0, "days<=0 drops nothing");

// days not a number -> pass through.
const invalid = filterByRecency(inputs, { days: NaN, now: NOW });
assert.equal(invalid.sources.length, inputs.length, "NaN days passes through");

// null days -> pass through.
const none = filterByRecency(inputs, { now: NOW });
assert.equal(none.sources.length, inputs.length, "no days argument passes through");

// days=1 should drop the 07-29 source too (older than a 1-day window ending 07-30).
const one = filterByRecency(inputs, { days: 1, now: NOW });
assert.equal(one.sources.length, 2, "days=1 keeps only today + undated");
assert.equal(one.dropped.length, 3, "days=1 drops yesterday + earlier");

console.log("recency filtering fixtures ok");
