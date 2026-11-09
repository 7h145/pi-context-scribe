import "./offline.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../src/summarize.ts";
import { inputTokens, requestText, type Accounting } from "../src/request.ts";
import { DEFAULT_TIMEOUT } from "../src/config.ts";
import { model, preparation, prompt, registry, response } from "./helpers.ts";

test("direct first, Pi output allowance, previous context and split prefix; boundary untouched", async () => {
  const prep = preparation("EARLY_CONSTRAINT");
  prep.previousSummary = "PREVIOUS_CONTEXT";
  prep.isSplitTurn = true;
  prep.turnPrefixMessages = [{ role: "user", content: "SPLIT_PREFIX", timestamp: 0 }];
  const original = structuredClone(prep);
  const mock = registry(() => response("COMPLETE".repeat(4000)));
  const log: Accounting = { partial: false };
  const result = await summarize(prep, "CURRENT_FOCUS", mock, model(), "low", DEFAULT_TIMEOUT,
    new AbortController().signal, log);
  assert.equal(result.chunks, 0);
  assert.equal(result.requests, 1);
  assert.equal(mock.calls[0].options.maxTokens, 13107);
  assert.equal(mock.calls[0].options.reasoning, "low");
  assert.equal(mock.calls[0].options.cacheRetention, "none");
  const text = prompt(mock.calls[0].context);
  for (const value of ["EARLY_CONSTRAINT", "PREVIOUS_CONTEXT", "SPLIT_PREFIX", "CURRENT_FOCUS", "split-turn prefix"]) {
    assert.ok(text.includes(value), value);
  }
  assert.deepEqual(prep, original);
  assert.equal(log.usage?.totalTokens, 135);
  // Completed overlength text is not rejected by a character-count policy.
  assert.ok(result.summary.length > 24000);
});

test("large message is fully segmented; independent notes, previous summary only at final synthesis", async () => {
  const m = model("small", 8000, 512);
  const prep = preparation("BEGIN_" + "x".repeat(38000) + "_END", 1000);
  prep.previousSummary = "PRIOR_ONLY_AT_SYNTHESIS";
  const mock = registry((_call, index) => response("notes " + index));
  const result = await summarize(prep, undefined, mock, m, "off", DEFAULT_TIMEOUT, new AbortController().signal, { partial: false });
  assert.ok(result.chunks > 1);
  assert.equal(result.requests, result.chunks + 1);
  const sources = mock.calls.slice(0, -1).map((call) => prompt(call.context));
  assert.ok(sources[0].includes("BEGIN_"));
  assert.ok(sources.at(-1)!.includes("_END"));
  const reconstructed = sources.map((text) => text.split("\n\nChronological evidence:\n")[1]
    .replace(/\[Record \d+ continuation at character \d+\]\n/g, "")
    .replace(/\[history message 1\]\n\[User\]: /, "")).join("");
  assert.equal(reconstructed, "BEGIN_" + "x".repeat(38000) + "_END");
  assert.ok(sources.every((text) => !text.includes("PRIOR_ONLY_AT_SYNTHESIS")));
  assert.ok(prompt(mock.calls.at(-1)!.context).includes("PRIOR_ONLY_AT_SYNTHESIS"));
  for (const call of mock.calls) {
    assert.ok(inputTokens(prompt(call.context)) + call.options.maxTokens! + 4096 <= m.contextWindow);
  }
  assert.ok(mock.calls.every((call) => call.model === m));
});

test("oversized collected notes are reduced chronologically before synthesis", async () => {
  const mock = registry((call, index) => {
    const text = prompt(call.context);
    return response(text.includes("Use these sections") ? "Final summary" :
      text.includes("[source chunk") ? "Reduced chronological evidence" : "note-" + index + " " + "n".repeat(4000));
  });
  const result = await summarize(preparation("x".repeat(150000), 3000), undefined, mock,
    model("small", 12000, 1600), "low", DEFAULT_TIMEOUT, new AbortController().signal, { partial: false });
  assert.ok(result.requests > result.chunks + 1);
  const finalInput = prompt(mock.calls.at(-1)!.context);
  assert.match(finalInput, /Reduced chronological evidence/);
  assert.match(finalInput, /source chunk 1-/);
  const covered = [...finalInput.matchAll(/\[source chunk (\d+)(?:-(\d+))?\]/g)].flatMap((match) =>
    Array.from({ length: Number(match[2] ?? match[1]) - Number(match[1]) + 1 }, (_, i) => Number(match[1]) + i));
  assert.deepEqual(covered, Array.from({ length: result.chunks }, (_, i) => i + 1));
  assert.equal(result.summary, "Final summary");
});

test("nonshrinking intermediate output terminates rather than looping", async () => {
  const mock = registry(() => response("n".repeat(10500)));
  await assert.rejects(summarize(preparation("x".repeat(70000), 7000), undefined, mock,
    model("small", 12000, 5000), "off", DEFAULT_TIMEOUT, new AbortController().signal,
    { partial: false }), /did not shrink/);
  assert.ok(mock.calls.length < 30);
});

test("failed late source chunk never installs an incomplete range", async () => {
  const mock = registry((_call, index) => response("notes", index === 1 ? "length" : "stop"));
  const log: Accounting = { partial: false };
  await assert.rejects(summarize(preparation("x".repeat(50000), 1000), undefined, mock,
    model("small", 8000, 512), "low", DEFAULT_TIMEOUT, new AbortController().signal, log), /incomplete/);
  assert.equal(mock.calls.length, 2);
  assert.equal(log.usage?.totalTokens, 270);
});

test("unusable output/window budget and oversized prior summary fail before making a request", async () => {
  const mock = registry(() => response());
  await assert.rejects(summarize(preparation(), undefined, mock, model("tiny", 500, 16000),
    "high", DEFAULT_TIMEOUT, new AbortController().signal, { partial: false }), /budget/);
  const prep = preparation("small", 1000);
  prep.previousSummary = "p".repeat(20000);
  await assert.rejects(summarize(prep, undefined, mock, model("small", 8000, 512),
    "low", DEFAULT_TIMEOUT, new AbortController().signal, { partial: false }), /previous summary/);
  assert.equal(mock.calls.length, 0);
});

test("per-request deadlines start fresh, and do not abort Pi's parent signal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const parent = new AbortController();
  const mock = registry(() => new Promise(() => {}));
  const log: Accounting = { partial: false };
  const timeout = { baseMs: 1000, msPer1000InputTokens: 0 };
  for (let i = 0; i < 2; i++) {
    const result = requestText(mock, model(), "low", "text", 1000, timeout, parent.signal, log);
    const rejected = assert.rejects(result, /timed out after 1s/);
    t.mock.timers.tick(999);
    assert.equal(mock.calls[i].options.signal?.aborted, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(parent.signal.aborted, false);
    assert.equal(mock.calls[i].options.signal?.aborted, true);
  }
  assert.equal(log.partial, true);
});

test("parent cancellation stops immediately; late completion is ignored", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  const mock = registry(() => new Promise((resolve) => { finish = resolve; }));
  const parent = new AbortController();
  const log: Accounting = { partial: false };
  const pending = requestText(mock, model(), "low", "text", 1000, DEFAULT_TIMEOUT, parent.signal, log);
  await Promise.resolve();
  parent.abort(new Error("user cancelled"));
  await assert.rejects(pending, /user cancelled/);
  finish(response());
  await Promise.resolve();
  assert.equal(log.usage, undefined);
});

const invalidOutputs: [string, ReturnType<typeof response>][] = [
  ["empty", response(" ")], ["error", response("fragment", "error")],
  ["length", response("fragment", "length")], ["aborted", response("fragment", "aborted")],
  ["tool call", { ...response(), content: [{ type: "toolCall" as const, id: "x", name: "bash", arguments: {} }] }],
];
for (const [name, value] of invalidOutputs) {
  test("reject " + name + " output, without discarding reported usage", async () => {
    const mock = registry(() => value);
    const log: Accounting = { partial: false };
    await assert.rejects(requestText(mock, model(), "low", "text", 1000, DEFAULT_TIMEOUT,
      new AbortController().signal, log));
    assert.equal(log.usage?.totalTokens, 135);
  });
}
