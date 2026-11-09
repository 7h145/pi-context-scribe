import "./offline.ts";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { completionLine, formatTokenCount, STATS_WIDGET } from "../src/stats.ts";
import { harness, preparation, response } from "./helpers.ts";

test("completion uses the last model component and only shortens its middle when needed", () => {
  const model = "private-provider/deepseek-ai/DeepSeek-V4.1-Flash-1017";
  const detail = "direct · 24.1s ↑85k ↓3,000";
  const wide = completionLine(model, detail, 160);
  assert.match(wide, /DeepSeek-V4.1-Flash-1017/);
  assert.doesNotMatch(wide, /private-provider|deepseek-ai/);
  assert.equal(completionLine(model, detail, 69), "context-scribe: DeepSeek-V4.1-Flash-1017 · " + detail);
  const narrow = completionLine(model, detail, 68);
  assert.match(narrow, /Deep.*….*1017/);
  assert.match(narrow, /↑85k ↓3,000/);
  assert.ok(visibleWidth(narrow) <= 68);
});

test("completion width is bounded for narrow, wide, Unicode and ANSI-containing names", () => {
  const detail = "chunked (3ch/4req) · 40.1s ↑100k ↓6,000 · usage partial";
  for (const name of ["provider/" + "model".repeat(30) + "-1017",
    "provider/" + "模型😀".repeat(10) + "-1017", "provider/\x1b[31mred-model\x1b[0m"]) {
    for (const width of [0, 1, 4, 20, 60, 80, 120, 200]) {
      assert.ok(visibleWidth(completionLine(name, detail, width)) <= width);
    }
  }
});

test("before notification remains; success uses one model-labelled widget, not an after notification", async (t) => {
  const h = await harness(t);
  const result = await h.before();
  assert.match(h.notifications.at(-1)!.message, /compacting with test\/a \(thinking: low\)/);
  const before = h.notifications.length;
  await h.emit("session_compact", { fromExtension: true, compactionEntry: result.compaction });
  assert.equal(h.notifications.length, before);
  assert.equal(h.widgets.size, 1);
  assert.match(h.widgetText(), /context-scribe: a · direct/);
  assert.match(h.widgetText(), /↑115 ↓20/);
  await h.command();
  assert.equal(h.widgets.size, 1);
});

for (const source of ["interactive", "rpc"]) {
  test("widget survives current activity and clears once after the next " + source + " input settles", async (t) => {
    const h = await harness(t);
    await h.emit("input", { source, text: "The current request" });
    await h.emit("agent_start");
    const result = await h.before();
    await h.emit("session_compact", { fromExtension: true, compactionEntry: result.compaction });
    // Multiple tool/model turns and even restarted agent loops can belong to one request.
    for (const boundary of ["turn_end", "agent_end", "agent_start", "turn_end", "agent_end", "agent_settled"]) {
      await h.emit(boundary);
      assert.equal(h.widgets.size, 1);
    }
    await h.command();
    await h.emit("input", { source: "extension", text: "Automatic extension message" });
    await h.emit("agent_start");
    await h.emit("agent_settled");
    assert.equal(h.widgets.size, 1);
    assert.deepEqual(await h.emit("input", { source, text: "My next request" }), { action: "continue" });
    for (const boundary of ["agent_start", "turn_end", "turn_end", "agent_end"]) {
      await h.emit(boundary);
      assert.equal(h.widgets.size, 1);
    }
    await h.emit("agent_settled");
    assert.equal(h.widgets.size, 0);
    assert.equal(h.widgetUpdates.filter((update) => update.content === undefined).length, 1);
    await h.emit("agent_settled");
    assert.equal(h.widgetUpdates.filter((update) => update.content === undefined).length, 1);
  });
}

test("a replacement compaction starts a fresh widget lifetime even after input armed the old one", async (t) => {
  const h = await harness(t);
  const first = await h.before();
  await h.emit("session_compact", { fromExtension: true, compactionEntry: first.compaction });
  await h.emit("input", { source: "interactive", text: "Next request" });
  const second = await h.before();
  await h.emit("session_compact", { fromExtension: true, compactionEntry: second.compaction });
  await h.emit("agent_settled");
  assert.equal(h.widgets.size, 1);
  await h.emit("input", { source: "interactive", text: "Another request" });
  await h.emit("agent_settled", { aborted: true });
  assert.equal(h.widgets.size, 0);
});

for (const boundary of ["session_start", "session_shutdown", "session_before_compact"]) {
  test("widget clears on " + boundary + " before any subsequent outcome", async (t) => {
    const h = await harness(t);
    const result = await h.before();
    await h.emit("session_compact", { fromExtension: true, compactionEntry: result.compaction });
    if (boundary === "session_before_compact") await h.before();
    else await h.emit(boundary, { reason: "reload" });
    assert.equal(h.widgets.size, 0);
  });
}

test("built-in fallback clears old stats and never creates a trailing widget", async (t) => {
  const h = await harness(t);
  const first = await h.before();
  await h.emit("session_compact", { fromExtension: true, compactionEntry: first.compaction });
  h.setReply(async () => response("bad", "error"));
  await h.before(preparation());
  assert.equal(h.widgets.size, 0);
  const updates = h.widgetUpdates.length;
  await h.emit("session_compact", { fromExtension: false, compactionEntry: { summary: "Pi summary" } });
  await h.emit("session_compact_failed", { aborted: false });
  assert.equal(h.widgetUpdates.length, updates);
  assert.equal(h.widgets.has(STATS_WIDGET), false);
  assert.match(h.notifications.at(-1)!.message, /handing over to Pi's built-in compaction/);
});

test("widget setter failure cannot turn successful compaction into failure or demote its model", async (t) => {
  const h = await harness(t);
  h.ctx.ui.setWidget = () => { throw new Error("widget unavailable"); };
  const result = await h.before();
  await h.emit("session_compact", { fromExtension: true, compactionEntry: result.compaction });
  await h.emit("turn_end");
  await h.before();
  assert.deepEqual(h.calls.map((call) => call.model.id), ["a", "a"]);
});

test("RPC retains its completion notification without requesting a terminal widget", async (t) => {
  const h = await harness(t);
  h.ctx.mode = "rpc";
  h.setReply(async () => {
    const reply = response();
    reply.usage = { ...reply.usage, input: 1000, output: 20,
      cacheRead: 43000, cacheWrite: 0, totalTokens: 44020 };
    return reply;
  });
  h.ctx.ui.setWidget = () => { assert.fail("RPC cannot render custom terminal components"); };
  const result = await h.before();
  await h.emit("session_compact", { fromExtension: true, compactionEntry: result.compaction });
  assert.match(h.notifications.at(-1)!.message, /compaction complete — test\/a · direct/);
  assert.match(h.notifications.at(-1)!.message,
    /44,000 tokens in · 20 tokens out \(cache: 43000 read, 0 written\)/);
});

test("Pi footer thresholds and rounding, except output stays exact through 9,999", () => {
  for (const [count, input, output] of [[0, "0", "0"], [999, "999", "999"],
    [1000, "1.0k", "1,000"], [1098, "1.1k", "1,098"], [9999, "10.0k", "9,999"],
    [10000, "10k", "10k"], [10999, "11k", "11k"], [111959, "112k", "112k"],
    [999999, "1000k", "1000k"], [1000000, "1.0M", "1.0M"],
    [1200000, "1.2M", "1.2M"], [1999999, "2.0M", "2.0M"],
    [10000000, "10M", "10M"], [10500000, "11M", "11M"]] as const) {
    assert.equal(formatTokenCount(count), input);
    assert.equal(formatTokenCount(count, true), output);
  }
});

test("widget uses compact arrows and retains whole-operation time across failed fallback", async (t) => {
  const h = await harness(t);
  let now = 0;
  t.mock.method(performance, "now", () => now);
  h.setReply(async (_call, index) => {
    if (index === 0) {
      now = 52000;
      throw new Error("request timed out");
    }
    now = 74000;
    const reply = response();
    reply.usage = { ...reply.usage, input: 111959, output: 1098,
      cacheRead: 0, cacheWrite: 0, totalTokens: 113057 };
    return reply;
  });
  const result = await h.before();
  await h.emit("session_compact", { fromExtension: true, compactionEntry: result.compaction });
  assert.equal(h.widgetText(), "context-scribe: b · direct · 74.0s ↑112k ↓1,098 · usage partial");
  assert.equal(result.compaction.usage.input, 111959);
  assert.equal(result.compaction.usage.output, 1098);
});

test("widget wires compact input/cache and exact output only below 10,000", async (t) => {
  const h = await harness(t);
  for (const [output, expected] of [[9999, "9,999"], [10000, "10k"]] as const) {
    h.setReply(async () => {
      const reply = response();
      reply.usage = { ...reply.usage, input: 0, cacheRead: 1098, cacheWrite: 0,
        output, totalTokens: 1098 + output };
      return reply;
    });
    const result = await h.before();
    await h.emit("session_compact", { fromExtension: true, compactionEntry: result.compaction });
    assert.ok(h.widgetText().includes("s ↑1.1k ↓" + expected + " R1.1k"));
    assert.doesNotMatch(h.widgetText(), / W|\(cache/);
    assert.equal(result.compaction.usage.cacheRead, 1098);
    assert.equal(result.compaction.usage.output, output);
  }
});

test("widget uses R/W cache labels, omits zero counters independently and keeps total input", async (t) => {
  const h = await harness(t);
  t.mock.method(performance, "now", () => 0);
  for (const [read, write, input, cache] of [
    [0, 0, "1.0k", ""],
    [43000, 0, "44k", " R43k"],
    [0, 2000, "3.0k", " W2.0k"],
    [43000, 2000, "46k", " R43k W2.0k"],
    [1, 2, "1.0k", " R1 W2"],
  ] as const) {
    h.setReply(async () => {
      const reply = response();
      reply.usage = { ...reply.usage, input: 1000, output: 20,
        cacheRead: read, cacheWrite: write, totalTokens: 1020 + read + write };
      return reply;
    });
    const result = await h.before();
    await h.emit("session_compact", { fromExtension: true, compactionEntry: result.compaction });
    assert.equal(h.widgetText(), "context-scribe: a · direct · 0.0s ↑" + input + " ↓20" + cache);
    assert.equal(result.compaction.usage.input, 1000);
    assert.equal(result.compaction.usage.cacheRead, read);
    assert.equal(result.compaction.usage.cacheWrite, write);
  }
});
