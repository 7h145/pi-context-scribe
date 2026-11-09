import "./offline.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { sandbox } from "./helpers.ts";

test("Pi's real loader accepts the package, compaction lifecycle and read-only status command", async (t) => {
  const { cwd, agent } = await sandbox(t);
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const entry = fileURLToPath(new URL(manifest.pi.extensions[0], root));
  const result = await discoverAndLoadExtensions([entry], cwd, agent);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings ?? [], []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  assert.deepEqual([...extension.handlers.keys()].sort(),
    ["session_start", "session_shutdown", "session_before_compact", "session_compact", "session_compact_failed",
      "input", "agent_settled"].sort());
  assert.equal(extension.tools.size, 0);
  assert.deepEqual([...extension.commands.keys()], ["context-scribe"]);
  const notices: string[] = [];
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  });
  const ctx = { cwd, isProjectTrusted: () => false,
    ui: { notify(message: string) { notices.push(message); } },
  } as unknown as ExtensionCommandContext;
  for (const start of extension.handlers.get("session_start") ?? []) await start({ type: "session_start", reason: "startup" }, ctx);
  await extension.commands.get("context-scribe")!.handler("", ctx);
  assert.ok(notices.at(-1)!.startsWith("context-scribe: v" + manifest.version));
  assert.equal(extension.flags.size, 0);
  assert.equal(extension.shortcuts.size, 0);
});
