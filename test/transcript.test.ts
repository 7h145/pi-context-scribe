import "./offline.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { excerpt, serialize } from "../src/transcript.ts";
import { response } from "./helpers.ts";

test("exact result and argument thresholds, omission sizes, and result tail", () => {
  assert.equal(excerpt("x".repeat(2000), true), "x".repeat(2000));
  assert.equal(excerpt("x".repeat(1000), false), "x".repeat(1000));
  const text = "H".repeat(1000) + "M".repeat(4000) + "T".repeat(1000);
  assert.equal(excerpt(text, true), "H".repeat(1000) + "\n[... 4000 characters omitted ...]\n" + "T".repeat(1000));
  assert.equal(excerpt(text, false), "H".repeat(1000) + "\n[... 5000 characters omitted ...]\n");
});
test("identity/error outside clipping, argument names/paths intact, thinking omitted, calls grouped with results", () => {
  const assistant = response();
  assistant.content = [{ type: "thinking", thinking: "PRIVATE_REASONING" },
    { type: "text", text: "Try a change" },
    { type: "toolCall", id: "c1", name: "write", arguments: { path: "src/a.ts", content: "X".repeat(3000) + "ARG_TAIL" } }];
  const units = serialize([assistant, { role: "toolResult", toolCallId: "c1", toolName: "write",
    content: [{ type: "text", text: "S".repeat(5000) + "FINAL_ERROR" }], isError: true, timestamp: 0 }], "history");
  assert.equal(units.length, 1);
  assert.match(units[0], /src\/a.ts/);
  assert.match(units[0], /reported error/);
  assert.match(units[0], /FINAL_ERROR/);
  assert.doesNotMatch(units[0], /ARG_TAIL|PRIVATE_REASONING/);
  assert.match(units[0], /content=/);
});
test("custom and user-bash messages use Pi conversion; excluded commands stay excluded", () => {
  const units = serialize([
    { role: "custom", customType: "note", content: "A custom constraint", display: true, timestamp: 0 },
    { role: "bashExecution", command: "false", output: "failure", exitCode: 1, cancelled: false, truncated: false, timestamp: 0 },
    { role: "bashExecution", command: "excluded", output: "DO_NOT_INCLUDE", exitCode: 0, cancelled: false,
      truncated: false, excludeFromContext: true, timestamp: 0 },
  ], "history").join("\n");
  assert.match(units, /custom constraint/);
  assert.match(units, /Command exited with code 1/);
  assert.doesNotMatch(units, /DO_NOT_INCLUDE/);
});
test("excerpts do not cut Unicode surrogate pairs", () => {
  for (const tail of [true, false]) {
    const output = excerpt("x".repeat(999) + "😀" + "x".repeat(2000) + "😀" + "x".repeat(999), tail);
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(output)), output);
  }
});
