// Adapted from pi-oaistt's MIT-licensed src/version.ts (thias, OpenAI Codex).
// Identify only this package; never borrow a parent workspace's Git revision.
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export interface InstallationIdentity { version?: string; commit?: string }
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const execute = promisify(execFile);

async function checkoutHead(root: string): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)));
  const { stdout } = await execute("git",
    ["--no-optional-locks", "-C", root, "--git-dir", join(root, ".git"), "rev-parse", "--verify", "HEAD"],
    { encoding: "utf8", timeout: 500, killSignal: "SIGKILL", maxBuffer: 4096,
      env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull,
        GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
  return stdout;
}

/** Once per loaded runtime from session_start, never on import or each status. */
export async function loadInstallationIdentity(
  root = fileURLToPath(new URL("../", import.meta.url)),
  git: (root: string) => Promise<string> = checkoutHead,
): Promise<InstallationIdentity> {
  const identity: InstallationIdentity = {};
  try {
    root = await realpath(root);
    const manifest = join(root, "package.json");
    const info = await lstat(manifest);
    if (!info.isFile() || info.size > 64 * 1024) return identity;
    const pkg: unknown = JSON.parse(await readFile(manifest, "utf8"));
    if (!pkg || typeof pkg !== "object" || !("name" in pkg) || pkg.name !== "pi-context-scribe" ||
        !("version" in pkg) || typeof pkg.version !== "string" || pkg.version.length > 64 ||
        !semver.test(pkg.version)) return identity;
    identity.version = pkg.version;
  } catch { return identity; }
  try {
    const metadata = await lstat(join(root, ".git"));
    // A real .git directory or worktree gitfile must be at the package root.
    if (!metadata.isDirectory() && !metadata.isFile()) return identity;
    const head = (await git(root)).trim();
    if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)) identity.commit = head.slice(0, 7);
  } catch { /* Optional Git: missing, broken or slow checkouts leave version only. */ }
  return identity;
}

export function versionLabel(identity: InstallationIdentity): string {
  if (!identity.version || identity.version.length > 64 || !semver.test(identity.version)) return "version unknown";
  const commit = identity.commit && /^[0-9a-f]{7}$/u.test(identity.commit) ? " (" + identity.commit + ")" : "";
  return "v" + identity.version + commit;
}
