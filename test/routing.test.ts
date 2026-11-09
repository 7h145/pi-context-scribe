import "./offline.ts";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { harness, model, preparation, prompt, response } from "./helpers.ts";

test("fallback is sticky; successful custom completion reports all observed usage only once", async (t) => {
  const h = await harness(t);
  h.setReply(async (call) => call.model.id === "a" ? response("bad", "error") : response());
  const result = await h.before();
  assert.deepEqual(h.calls.map((call) => call.model.id), ["a", "b"]);
  assert.equal(result.compaction.firstKeptEntryId, "keep-boundary");
  assert.equal(result.compaction.tokensBefore, 50000);
  assert.equal(result.compaction.usage.totalTokens, 270);
  assert.equal(h.ctx.model?.id, "coding");
  const event = { fromExtension: true, compactionEntry: { ...result.compaction, type: "compaction" } };
  await h.emit("session_compact", event);
  await h.emit("session_compact", event);
  assert.equal(h.widgetUpdates.filter((update) => update.content !== undefined).length, 1);
  assert.match(h.widgetText(), /context-scribe: b · direct/);
  assert.ok(!h.notifications.some((n) => n.message.includes("compaction complete")));
  await h.before();
  assert.deepEqual(h.calls.map((call) => call.model.id), ["a", "b", "b"]);
  assert.ok(h.notifications.some((n) => n.type === "warning" && n.message.includes("test/a failed")));
});

test("exhaustion delegates to Pi, stays sticky, and has no trailing line for any terminal event", async (t) => {
  const h = await harness(t);
  h.setReply(async () => response("bad", "error"));
  assert.equal(await h.before(), undefined);
  const count = h.notifications.length;
  await h.emit("session_compact", { fromExtension: false, compactionEntry: { summary: "Pi summary" } });
  await h.emit("session_compact_failed", { aborted: false });
  await h.emit("session_compact_failed", { aborted: true });
  assert.equal(h.notifications.length, count);
  assert.match(h.notifications.at(-1)!.message, /handing over to Pi's built-in/);
  assert.equal(await h.before(), undefined);
  assert.equal(h.calls.length, 2);
  const stickyCount = h.notifications.length;
  await h.emit("session_compact", { fromExtension: false, compactionEntry: {} });
  assert.equal(h.notifications.length, stickyCount);
});

for (const reason of ["reload", "new", "resume", "fork"]) {
  test(reason + " resets routing and reads current config", async (t) => {
    const h = await harness(t);
    h.setReply(async () => response("bad", "error"));
    await h.before();
    h.setReply(async () => response());
    await h.emit("session_start", { reason });
    await h.before();
    assert.deepEqual(h.calls.map((call) => call.model.id), ["a", "b", "a"]);
  });
}

test("configuration changes only take effect at activation, with per-model/default thinking", async (t) => {
  const h = await harness(t, { models: [{ model: "test/a", thinking: "off" }], defaultThinking: "high" });
  await h.before();
  assert.equal(h.calls[0].options.reasoning, undefined);
  await writeFile(h.path, '{"models":["test/b"],"defaultThinking":"minimal"}');
  await h.before();
  assert.equal(h.calls[1].model.id, "a");
  await h.emit("session_start", { reason: "reload" });
  await h.before();
  assert.equal(h.calls[2].model.id, "b");
  assert.equal(h.calls[2].options.reasoning, "minimal");
});

test("effective thinking is clamped by Pi without changing the coding model", async (t) => {
  const h = await harness(t, { models: ["test/a"] });
  h.models.get("a")!.reasoning = false;
  await h.before();
  assert.equal(h.calls[0].options.reasoning, undefined);
  assert.match(h.notifications[0].message, /thinking: off; requested: low/);
  assert.equal(h.ctx.model?.id, "coding");
});

test("bad config, missing models and UI failure cannot block default compaction", async (t) => {
  const h = await harness(t, { models: ["test/missing"] });
  assert.equal(await h.before(), undefined);
  assert.equal(h.calls.length, 0);
  await writeFile(h.path, "{invalid}");
  await h.emit("session_start", { reason: "reload" });
  h.ctx.ui.notify = () => { throw new Error("UI failure"); };
  assert.equal(await h.before(), undefined);
});

test("chunking stays on preferred model and is identified in completion statistics", async (t) => {
  const h = await harness(t);
  h.models.set("a", model("a", 8000, 512));
  const result = await h.before(preparation("x".repeat(38000), 1000));
  assert.ok(h.calls.length > 2);
  assert.ok(h.calls.every((call) => call.model.id === "a"));
  await h.emit("session_compact", { fromExtension: true, compactionEntry: result.compaction });
  assert.match(h.widgetText(), /chunked \(\d+ch\/\d+req\)/);
});

test("a late chunk failure restarts original input on next candidate, not partial notes", async (t) => {
  const h = await harness(t);
  h.models.set("a", model("a", 8000, 512));
  h.setReply(async (call, index) => call.model.id === "a" ?
    response("PARTIAL_A_NOTES", index === 1 ? "error" : "stop") : response("B_COMPLETE"));
  const result = await h.before(preparation("ORIGINAL_BEGIN" + "x".repeat(38000) + "ORIGINAL_END", 1000));
  assert.equal(result.compaction.summary, "B_COMPLETE");
  const b = h.calls.filter((call) => call.model.id === "b");
  assert.equal(b.length, 1);
  assert.match(prompt(b[0].context), /ORIGINAL_BEGIN/);
  assert.match(prompt(b[0].context), /ORIGINAL_END/);
  assert.doesNotMatch(prompt(b[0].context), /PARTIAL_A_NOTES/);
});

test("user cancellation does not demote the candidate", async (t) => {
  const h = await harness(t);
  h.setReply(async () => new Promise(() => {}));
  const parent = new AbortController();
  const pending = h.before(preparation(), parent.signal);
  await Promise.resolve();
  parent.abort();
  assert.deepEqual(await pending, { cancel: true });
  await h.emit("session_compact_failed", { aborted: true });
  h.setReply(async () => response());
  await h.before();
  assert.deepEqual(h.calls.map((call) => call.model.id), ["a", "a"]);
});

test("shutdown/reload invalidate in-flight requests and suppress stale completion reporting", async (t) => {
  const h = await harness(t);
  h.setReply(async () => new Promise(() => {}));
  const pending = h.before();
  await Promise.resolve();
  await h.emit("session_shutdown", { reason: "reload" });
  await h.emit("session_start", { reason: "reload" });
  assert.deepEqual(await pending, { cancel: true });
  const count = h.notifications.length;
  await h.emit("session_compact_failed", { aborted: true });
  assert.equal(h.notifications.length, count);
});

test("prior file evidence survives extension-generated compactions without treating calls as proof", async (t) => {
  const h = await harness(t);
  const prep = preparation();
  prep.fileOps.edited.add("new.ts");
  const event = { preparation: prep, branchEntries: [{ type: "compaction", details: {
    contextScribe: true, readFiles: ["read.ts"], modifiedFiles: ["old.ts"] } }],
    signal: new AbortController().signal };
  const result = await h.emit("session_before_compact", event);
  assert.deepEqual(result.compaction.details.modifiedFiles, ["new.ts", "old.ts"]);
  assert.match(result.compaction.summary, /not independent verification of success/);
  assert.match(result.compaction.summary, /read.ts/);
});

test("request timeout advances once, later requests use the sticky successful fallback", async (t) => {
  const h = await harness(t, { models: ["test/a", "test/b"], timeout: { baseMs: 1000, msPer1000InputTokens: 0 } });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  h.setReply(async (call) => call.model.id === "a" ? new Promise(() => {}) : response());
  const pending = h.before();
  await Promise.resolve();
  t.mock.timers.tick(1000);
  const result = await pending;
  assert.equal(result.compaction.details.model, "test/b");
  assert.equal(result.compaction.details.usagePartial, true);
  await h.before();
  assert.deepEqual(h.calls.map((call) => call.model.id), ["a", "b", "b"]);
  assert.ok(h.notifications.some((n) => n.message.includes("timed out")));
});

test("notification failures cannot turn a successful custom summary into default fallback", async (t) => {
  const h = await harness(t);
  h.ctx.ui.notify = () => { throw new Error("broken UI"); };
  const result = await h.before();
  assert.ok(result.compaction);
  await h.emit("session_compact", { fromExtension: true, compactionEntry: result.compaction });
  assert.deepEqual(h.calls.map((call) => call.model.id), ["a"]);
});

test("unknown usage stays unavailable rather than becoming a fabricated zero total", async (t) => {
  const h = await harness(t);
  h.setReply(async () => {
    const r = response();
    r.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    return r;
  });
  const result = await h.before();
  assert.equal(result.compaction.usage, undefined);
  await h.emit("session_compact", { fromExtension: true, compactionEntry: result.compaction });
  assert.match(h.widgetText(), /usage unavailable/);
});
