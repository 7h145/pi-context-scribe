import "./offline.ts";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_TIMEOUT, loadConfig, requestTimeout } from "../src/config.ts";
import { sandbox } from "./helpers.ts";

test("missing configuration delegates to Pi; a model list alone gets all defaults", async (t) => {
  const { cwd, agent } = await sandbox(t);
  assert.deepEqual(loadConfig(cwd, agent), { models: [], defaultThinking: "low", timeout: DEFAULT_TIMEOUT });
  await writeFile(join(agent, "pi-context-scribe.json"), JSON.stringify({ models: ["provider/nested/model"] }));
  assert.deepEqual(loadConfig(cwd, agent).models, [{ model: "provider/nested/model" }]);
  assert.equal(loadConfig(cwd, agent).defaultThinking, "low");
});
test("project list replaces global; timeout overrides per field and explicit zero survives", async (t) => {
  const { cwd, agent } = await sandbox(t);
  await writeFile(join(agent, "pi-context-scribe.json"), JSON.stringify({
    models: ["global/a"], defaultThinking: "high", timeout: { baseMs: 50000, msPer1000InputTokens: 100 },
  }));
  await writeFile(join(cwd, ".pi", "pi-context-scribe.json"), JSON.stringify({
    models: [{ model: "project/b", thinking: "off" }], defaultThinking: "minimal",
    timeout: { msPer1000InputTokens: 0 },
  }));
  assert.deepEqual(loadConfig(cwd, agent), { models: [{ model: "project/b", thinking: "off" }],
    defaultThinking: "minimal", timeout: { baseMs: 50000, msPer1000InputTokens: 0 } });
  assert.equal(requestTimeout(100000, loadConfig(cwd, agent).timeout), 50000);
});
test("partial project configuration inherits models and defaults", async (t) => {
  const { cwd, agent } = await sandbox(t);
  await writeFile(join(agent, "pi-context-scribe.json"), '{"models":["p/a"]}');
  await writeFile(join(cwd, ".pi", "pi-context-scribe.json"), '{"timeout":{"baseMs":55000}}');
  assert.deepEqual(loadConfig(cwd, agent).timeout, { baseMs: 55000, msPer1000InputTokens: 250 });
});
test("reject malformed, unknown and invalid effective settings, without rewriting", async (t) => {
  const { cwd, agent } = await sandbox(t);
  const path = join(agent, "pi-context-scribe.json");
  for (const raw of ['{', '{}', '{"models":"p/a"}', '{"models":["invalid"]}',
    '{"models":["p/a","p/a"]}', '{"models":[{"model":"p/a","thinking":"fast"}]}',
    '{"models":[],"timeout":{"baseMs":0}}', '{"models":[],"timeout":{"msPer1000InputTokens":-1}}',
    '{"models":[],"extra":true}', '{"models":[],"timeout":null}']) {
    await writeFile(path, raw);
    assert.throws(() => loadConfig(cwd, agent), Error, raw);
  }
});
test("timeout is proportional to full estimated request input and safe for Node timers", () => {
  assert.deepEqual(DEFAULT_TIMEOUT, { baseMs: 45000, msPer1000InputTokens: 250 });
  assert.equal(requestTimeout(0, DEFAULT_TIMEOUT), 45000);
  assert.equal(requestTimeout(1, DEFAULT_TIMEOUT), 45001);
  assert.equal(requestTimeout(100000, DEFAULT_TIMEOUT), 70000);
  assert.equal(requestTimeout(110560, DEFAULT_TIMEOUT), 72640);
  assert.equal(requestTimeout(500000, DEFAULT_TIMEOUT), 170000);
  assert.equal(requestTimeout(1e20, DEFAULT_TIMEOUT), 2147483647);
});

test("untrusted project configuration cannot override the global route", async (t) => {
  const { cwd, agent } = await sandbox(t);
  await writeFile(join(agent, "pi-context-scribe.json"), '{"models":["global/a"]}');
  await writeFile(join(cwd, ".pi", "pi-context-scribe.json"), '{"models":["project/b"]}');
  assert.deepEqual(loadConfig(cwd, agent, false).models, [{ model: "global/a" }]);
});
