/**
 * pi-context-scribe scaffold checks
 *
 * Purpose: verify an inert factory and acceptance by Pi's extension loader.
 * Strategy: reject API access and load in temporary offline directories.
 * Author: thias, OpenAI assistant
 * License: MIT
 * Version: 0.1.0
 * Date: 2026-11-09
 * Last verified with Node.js: 26.10.0 (scaffold checks; Pi 1.3.0)
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import contextScribe from "../src/index.ts";

test("the scaffold does not access Pi's API", () => {
  const api = new Proxy({} as ExtensionAPI, {
    get(_target, property) {
      assert.fail(`Unexpected Pi API access: ${String(property)}`);
    },
  });

  assert.equal(contextScribe(api), undefined);
});

test("Pi loads the package entry point without registering behavior", async (t) => {
  // Set before importing Pi so importing it cannot refresh model catalogs.
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  t.after(() => {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  });
  const { discoverAndLoadExtensions } = await import("@earendil-works/pi-coding-agent");
  const sandbox = await mkdtemp(join(tmpdir(), "pi-context-scribe-test-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const cwd = join(sandbox, "project");
  const agentDir = join(sandbox, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const entry = fileURLToPath(new URL(manifest.pi.extensions[0], root));
  const result = await discoverAndLoadExtensions([entry], cwd, agentDir);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings ?? [], []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  assert.equal(extension.handlers.size, 0);
  assert.equal(extension.tools.size, 0);
  assert.equal(extension.commands.size, 0);
  assert.equal(extension.flags.size, 0);
  assert.equal(extension.shortcuts.size, 0);
});
