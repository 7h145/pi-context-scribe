import "./offline.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { loadInstallationIdentity, versionLabel } from "../src/version.ts";
import { sandbox } from "./helpers.ts";

async function fixture(t: TestContext, version: unknown = "0.1.0") {
  const box = await sandbox(t);
  const root = join(box.root, "installed package");
  await mkdir(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pi-context-scribe", version }));
  return { root, parent: box.root };
}

test("non-Git installations never borrow a parent repository's HEAD", async (t) => {
  const h = await fixture(t);
  await mkdir(join(h.parent, ".git"));
  let queries = 0;
  assert.deepEqual(await loadInstallationIdentity(h.root, async () => { queries++; return "a".repeat(40); }), { version: "0.1.0" });
  assert.equal(queries, 0);
  assert.equal(versionLabel({ version: "0.1.0" }), "v0.1.0");
});

test("own Git directories and worktree gitfiles accept full SHA-1/SHA-256 only", async (t) => {
  for (const length of [40, 64]) for (const gitfile of [false, true]) {
    const h = await fixture(t, "0.1.0-rc.1+fixture");
    if (gitfile) await writeFile(join(h.root, ".git"), "gitdir: /synthetic\n");
    else await mkdir(join(h.root, ".git"));
    const identity = await loadInstallationIdentity(h.root, async (root) => {
      assert.equal(root, h.root);
      return "1234abc" + "d".repeat(length - 7) + "\n";
    });
    assert.deepEqual(identity, { version: "0.1.0-rc.1+fixture", commit: "1234abc" });
    assert.equal(versionLabel(identity), "v0.1.0-rc.1+fixture (1234abc)");
  }
});

test("symlinked package resolves its own root, not the link's workspace", async (t) => {
  const h = await fixture(t);
  await mkdir(join(h.root, ".git"));
  const link = join(h.parent, "extension-link");
  await symlink(h.root, link);
  const identity = await loadInstallationIdentity(link, async (root) => {
    assert.equal(root, h.root);
    return "a".repeat(40);
  });
  assert.equal(versionLabel(identity), "v0.1.0 (aaaaaaa)");
});

test("missing/broken Git and unsafe Git output leave a version-only label", async (t) => {
  const h = await fixture(t);
  await mkdir(join(h.root, ".git"));
  for (const head of ["", "1234abc", "UNSAFE\nOUTPUT", "a".repeat(40) + "\n" + "b".repeat(40)]) {
    assert.deepEqual(await loadInstallationIdentity(h.root, async () => head), { version: "0.1.0" });
  }
  assert.deepEqual(await loadInstallationIdentity(h.root, async () => { throw new Error("missing Git"); }), { version: "0.1.0" });
});

test("missing, broken, unrelated or oversized manifests never query Git", async (t) => {
  const h = await fixture(t);
  await mkdir(join(h.root, ".git"));
  const path = join(h.root, "package.json");
  let queries = 0;
  const forbidden = async (): Promise<string> => { queries++; return "a".repeat(40); };
  for (const raw of ["{", '{"name":"other","version":"1.0.0"}', " ".repeat(65537),
    '{"name":"pi-context-scribe","version":"0.1.0\\nunsafe"}']) {
    await writeFile(path, raw);
    assert.deepEqual(await loadInstallationIdentity(h.root, forbidden), {});
  }
  await rm(path);
  assert.deepEqual(await loadInstallationIdentity(h.root, forbidden), {});
  assert.equal(queries, 0);
});

test("version formatter cannot emit arbitrary metadata", () => {
  assert.equal(versionLabel({}), "version unknown");
  assert.equal(versionLabel({ version: "0.1.0\nunsafe", commit: "1234abc" }), "version unknown");
  assert.equal(versionLabel({ version: "0.1.0", commit: "UNSAFE" }), "v0.1.0");
  assert.equal(versionLabel({ version: "0.1.0-" + "x".repeat(65) }), "version unknown");
});

test("real Git resolves the package/worktree HEAD and ignores ambient repository overrides", async (t) => {
  const h = await fixture(t);
  const execute = promisify(execFile);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key))),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0" };
  const git = (args: string[]) => execute("git", ["-c", "maintenance.auto=false", "-C", h.root, ...args],
    { env, timeout: 3000 });
  await git(["init", "--quiet", "--initial-branch=main"]);
  await git(["add", "package.json"]);
  await git(["-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgSign=false", "commit", "--quiet", "-m", "synthetic fixture"]);
  const expected = (await git(["rev-parse", "HEAD"])).stdout.trim().slice(0, 7);
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_COMMON_DIR: process.env.GIT_COMMON_DIR };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.GIT_DIR = join(h.parent, "unrelated");
  process.env.GIT_WORK_TREE = h.parent;
  process.env.GIT_COMMON_DIR = join(h.parent, "unrelated");
  assert.deepEqual(await loadInstallationIdentity(h.root), { version: "0.1.0", commit: expected });
  const worktree = join(h.parent, "worktree");
  await git(["worktree", "add", "--quiet", "--detach", worktree]);
  assert.deepEqual(await loadInstallationIdentity(worktree), { version: "0.1.0", commit: expected });
});

test("a stalled Git executable is killed/reaped and falls back to the package version", async (t) => {
  const h = await fixture(t);
  await mkdir(join(h.root, ".git"));
  const bin = join(h.parent, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "git"), "#!" + process.execPath +
    "\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n", { mode: 0o700 });
  const saved = process.env.PATH;
  t.after(() => { if (saved === undefined) delete process.env.PATH; else process.env.PATH = saved; });
  process.env.PATH = bin;
  assert.deepEqual(await loadInstallationIdentity(h.root), { version: "0.1.0" });
});
