import "./offline.ts";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { harness, response } from "./helpers.ts";

test("default, status and s show the loaded package version, ordered chain and current route without requests", async (t) => {
  const h = await harness(t);
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const snapshots: string[] = [];
  for (const args of ["", "status", "s", " status "]) {
    await h.command(args);
    const text = h.notifications.at(-1)!.message;
    snapshots.push(text);
    assert.ok(text.startsWith("context-scribe: v" + manifest.version));
    assert.match(text, /\n\nCurrent compaction route:/);
    assert.match(text, /\n\n\/reload reloads/);
    assert.match(text, /Current compaction route: test\/a \(thinking: low\)/);
    assert.match(text, /→ 1\. test\/a/);
    assert.match(text, /2\. test\/b/);
    assert.match(text, /3\. Pi's built-in compaction \(coding model: test\/coding\)/);
    assert.doesNotMatch(text, /Status does not probe providers/);
  }
  assert.ok(snapshots.every((text) => text === snapshots[0]));
  assert.equal(h.calls.length, 0);
  assert.equal(h.ctx.model?.id, "coding");
});

test("status follows sticky fallback and reset, not on-disk config edits before reload", async (t) => {
  const h = await harness(t);
  h.setReply(async (call) => response("summary", call.model.id === "a" ? "error" : "stop"));
  await h.before();
  await writeFile(h.path, '{"models":["test/a"]}');
  await h.command();
  let text = h.notifications.at(-1)!.message;
  assert.match(text, /Current compaction route: test\/b/);
  assert.match(text, /1\. test\/a.*\[skipped until reset\]/);
  assert.match(text, /→ 2\. test\/b/);
  assert.equal(h.calls.length, 2);
  await h.emit("session_start", { reason: "reload" });
  await h.command("s");
  text = h.notifications.at(-1)!.message;
  assert.match(text, /Current compaction route: test\/a/);
  assert.doesNotMatch(text, /test\/b|skipped until reset/);
  assert.equal(h.calls.length, 2);
});

test("status shows built-in compaction as the current sticky route without retrying candidates", async (t) => {
  const h = await harness(t);
  h.setReply(async () => response("bad", "error"));
  await h.before();
  await h.command();
  const text = h.notifications.at(-1)!.message;
  assert.match(text, /Current compaction route: Pi's built-in compaction/);
  assert.match(text, /→ 3\. Pi's built-in compaction/);
  assert.equal(text.match(/skipped until reset/g)?.length, 2);
  assert.equal(h.calls.length, 2);
  await h.before();
  assert.equal(h.calls.length, 2);
});

test("status reports effective and requested thinking and unresolved model IDs without changing the cursor", async (t) => {
  const h = await harness(t, {
    models: [{ model: "test/a", thinking: "high" }, "test/missing", "test/b"], defaultThinking: "minimal",
  });
  h.models.get("a")!.reasoning = false;
  await h.command();
  const text = h.notifications.at(-1)!.message;
  assert.match(text, /test\/a \(thinking: off; requested: high\)/);
  assert.match(text, /test\/missing \(requested thinking: minimal; not registered\)/);
  assert.match(text, /test\/b \(thinking: minimal\)/);
  assert.equal(h.calls.length, 0);
  await h.before();
  assert.equal(h.calls[0].model.id, "a");
});

test("no configured models reports built-in compaction", async (t) => {
  const h = await harness(t, { models: [] });
  await h.command();
  const text = h.notifications.at(-1)!.message;
  assert.match(text, /Current compaction route: Pi's built-in compaction/);
  assert.match(text, /→ 1\. Pi's built-in compaction/);
  assert.equal(h.calls.length, 0);
});

test("unsupported arguments show usage without resetting routing or making a request", async (t) => {
  const h = await harness(t);
  h.setReply(async (call) => response("summary", call.model.id === "a" ? "error" : "stop"));
  await h.before();
  for (const args of ["reload", "status extra", "save", "st", "s extra", "STATUS"]) {
    await h.command(args);
    assert.equal(h.notifications.at(-1)!.type, "warning");
    assert.match(h.notifications.at(-1)!.message, /Usage: \/context-scribe \[status\|s\]/);
  }
  assert.equal(h.calls.length, 2);
  await h.before();
  assert.deepEqual(h.calls.map((call) => call.model.id), ["a", "b", "b"]);
});

test("status presentation and registry lookup errors do not change compaction state", async (t) => {
  const h = await harness(t);
  const find = h.ctx.modelRegistry.find;
  h.ctx.modelRegistry.find = () => { throw new Error("registry unavailable"); };
  await h.command();
  assert.match(h.notifications.at(-1)!.message, /registry lookup failed/);
  h.ctx.modelRegistry.find = find;
  h.ctx.ui.notify = () => { throw new Error("UI unavailable"); };
  await h.command();
  assert.equal(h.calls.length, 0);
  await h.before();
  assert.equal(h.calls[0].model.id, "a");
});
