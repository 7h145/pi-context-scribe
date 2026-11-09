import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface Candidate {
  model: string;
  thinking?: ModelThinkingLevel;
}
export interface Timeout {
  baseMs: number;
  msPer1000InputTokens: number;
}
export interface Config {
  models: Candidate[];
  defaultThinking: ModelThinkingLevel;
  timeout: Timeout;
}

// Provisional allowances for dogfooding, not measured throughput guarantees.
export const DEFAULT_TIMEOUT: Timeout = { baseMs: 45_000, msPer1000InputTokens: 250 };
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
type Layer = Partial<Omit<Config, "timeout">> & { timeout?: Partial<Timeout> };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("unknown configuration field");
}
function thinking(value: unknown): ModelThinkingLevel {
  if (typeof value !== "string" || !LEVELS.includes(value)) throw new Error("invalid thinking level");
  return value as ModelThinkingLevel;
}

function parse(value: unknown): Layer {
  const root = object(value);
  keys(root, ["models", "defaultThinking", "timeout"]);
  const result: Layer = {};
  if (root.models !== undefined) {
    if (!Array.isArray(root.models)) throw new Error("models must be a list");
    const seen = new Set<string>();
    result.models = root.models.map((entry: unknown): Candidate => {
      const item = typeof entry === "string" ? { model: entry } : object(entry);
      keys(item, ["model", "thinking"]);
      if (typeof item.model !== "string" || !/^[^/\s]+\/\S+$/.test(item.model)) {
        throw new Error("model must be provider/modelId");
      }
      if (seen.has(item.model)) throw new Error("duplicate model");
      seen.add(item.model);
      return { model: item.model, ...(item.thinking === undefined ? {} : { thinking: thinking(item.thinking) }) };
    });
  }
  if (root.defaultThinking !== undefined) result.defaultThinking = thinking(root.defaultThinking);
  if (root.timeout !== undefined) {
    const timeout = object(root.timeout);
    keys(timeout, ["baseMs", "msPer1000InputTokens"]);
    result.timeout = {};
    for (const key of ["baseMs", "msPer1000InputTokens"] as const) {
      const n = timeout[key];
      if (n === undefined) continue;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 2_147_483_647 ||
          (key === "baseMs" && n === 0)) throw new Error("invalid timeout allowance");
      result.timeout[key] = n;
    }
  }
  return result;
}

export function loadConfig(cwd: string, agentDir: string, projectTrusted = true): Config {
  let exists = false;
  function read(path: string): Layer {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Cannot read " + path);
    }
    exists = true;
    try { return parse(JSON.parse(raw)); }
    catch (error) {
      // Do not echo arbitrary JSON or provider errors containing private values.
      const reason = error instanceof SyntaxError ? "invalid JSON" : (error as Error).message;
      throw new Error(path + ": " + reason);
    }
  }
  const global = read(join(agentDir, "pi-context-scribe.json"));
  const project = projectTrusted ? read(join(cwd, ".pi", "pi-context-scribe.json")) : {};
  const models = project.models ?? global.models;
  if (exists && models === undefined) throw new Error("pi-context-scribe.json requires models");
  return {
    models: models ?? [],
    defaultThinking: project.defaultThinking ?? global.defaultThinking ?? "low",
    timeout: { ...DEFAULT_TIMEOUT, ...global.timeout, ...project.timeout },
  };
}

export function requestTimeout(inputTokens: number, timeout: Timeout): number {
  return Math.min(2_147_483_647,
    Math.ceil(timeout.baseMs + timeout.msPer1000InputTokens * inputTokens / 1000));
}
