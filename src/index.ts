import { performance } from "node:perf_hooks";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TIMEOUT, loadConfig, type Config } from "./config.ts";
import type { Accounting } from "./request.ts";
import { summarize, type SummaryResult } from "./summarize.ts";
import { loadInstallationIdentity, versionLabel, type InstallationIdentity } from "./version.ts";
import { completionLine, formatTokenCount, STATS_WIDGET } from "./stats.ts";

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" = "info"): void {
  try { ctx.ui.notify("context-scribe: " + message, type); }
  catch { /* Presentation must never change compaction's outcome. */ }
}
function reason(error: unknown): string {
  return (error instanceof Error ? error.message : "unexpected extension error")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 240);
}
function files(event: SessionBeforeCompactEvent) {
  const read = new Set(event.preparation.fileOps.read);
  const modified = new Set([...event.preparation.fileOps.written, ...event.preparation.fileOps.edited]);
  const previous = event.branchEntries.findLast((entry) => entry.type === "compaction");
  if (previous?.type === "compaction" && previous.details && typeof previous.details === "object") {
    const details = previous.details as Record<string, unknown>;
    if (details.contextScribe === true) {
      for (const [key, target] of [["readFiles", read], ["modifiedFiles", modified]] as const) {
        const list = details[key];
        if (Array.isArray(list)) for (const path of list) if (typeof path === "string") target.add(path);
      }
    }
  }
  return { readFiles: [...read].filter((path) => !modified.has(path)).sort(), modifiedFiles: [...modified].sort() };
}
function fileText(evidence: ReturnType<typeof files>): string {
  const sections: string[] = [];
  for (const [tag, paths] of [["read-files", evidence.readFiles], ["modified-files", evidence.modifiedFiles]] as const) {
    if (paths.length) sections.push("<" + tag + ">\n" + paths.join("\n") + "\n</" + tag + ">");
  }
  return sections.length ? "\n\nFile-operation evidence (tool calls, not independent verification of success):\n" +
    sections.join("\n\n") : "";
}

interface Run {
  started: number;
  accounting: Accounting;
  result?: SummaryResult;
  summary?: string;
  model?: string;
}
interface State {
  config: Config;
  cursor: number;
  lifetime: AbortController;
  pending?: Run;
  stats?: "awaiting-input" | "awaiting-settle";
}
function fresh(): State {
  return { config: { models: [], defaultThinking: "low", timeout: { ...DEFAULT_TIMEOUT } },
    cursor: 0, lifetime: new AbortController() };
}
function statistics(run: Run, compact = false): string {
  const usage = run.accounting.usage;
  let text = ((performance.now() - run.started) / 1000).toFixed(1) + "s";
  if (usage) {
    const input = usage.input + usage.cacheRead + usage.cacheWrite;
    text += compact ? " ↑" + formatTokenCount(input) + " ↓" + formatTokenCount(usage.output, true) :
      " · " + input.toLocaleString("en-US") + " tokens in · " + usage.output.toLocaleString("en-US") + " tokens out";
    if (compact) {
      if (usage.cacheRead) text += " R" + formatTokenCount(usage.cacheRead);
      if (usage.cacheWrite) text += " W" + formatTokenCount(usage.cacheWrite);
    } else if (usage.cacheRead || usage.cacheWrite) {
      text += " (cache: " + usage.cacheRead + " read, " + usage.cacheWrite + " written)";
    }
    if (run.accounting.partial) text += " · usage partial";
  } else text += " · usage unavailable";
  return text;
}

export default function contextScribe(pi: ExtensionAPI): void {
  let identity: InstallationIdentity = {};
  let identityReady: Promise<void> | undefined;
  let state = fresh();
  function clearStats(ctx: ExtensionContext): void {
    if (!state.stats) return;
    state.stats = undefined;
    try { ctx.ui.setWidget(STATS_WIDGET, undefined); }
    catch { /* UI cleanup must not affect the session. */ }
  }
  pi.registerCommand("context-scribe", {
    description: "Show context-scribe version, model chain and current compaction route",
    handler: async (args, ctx) => {
      if (!["", "s", "status"].includes(args.trim())) {
        notify(ctx, "Usage: /context-scribe [status|s]", "warning");
        return;
      }
      const labels = state.config.models.map((candidate) => {
        const requested = candidate.thinking ?? state.config.defaultThinking;
        const slash = candidate.model.indexOf("/");
        try {
          const model = ctx.modelRegistry.find(candidate.model.slice(0, slash), candidate.model.slice(slash + 1));
          if (!model) return candidate.model + " (requested thinking: " + requested + "; not registered)";
          const effective = clampThinkingLevel(model, requested);
          return candidate.model + " (thinking: " + effective +
            (effective === requested ? "" : "; requested: " + requested) + ")";
        } catch {
          return candidate.model + " (requested thinking: " + requested + "; registry lookup failed)";
        }
      });
      labels.push("Pi's built-in compaction" +
        (ctx.model ? " (coding model: " + ctx.model.provider + "/" + ctx.model.id + ")" : ""));
      const current = Math.min(state.cursor, labels.length - 1);
      const lines = labels.map((label, index) =>
        (index === current ? "  → " : "    ") + (index + 1) + ". " + label +
        (index < current ? " [skipped until reset]" : ""));
      notify(ctx, versionLabel(identity) + "\n\nCurrent compaction route: " + labels[current] +
        "\nModel chain:\n" + lines.join("\n") +
        "\n\n/reload reloads configuration and resets fallback order.");
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    clearStats(ctx);
    state.lifetime.abort();
    state = fresh();
    try { state.config = loadConfig(ctx.cwd, getAgentDir(), ctx.isProjectTrusted()); }
    catch (error) { notify(ctx, reason(error) + "; using Pi's built-in compaction", "warning"); }
    identityReady ??= loadInstallationIdentity().then((value) => { identity = value; }).catch(() => {});
    await identityReady;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    clearStats(ctx);
    state.pending = undefined;
    state.lifetime.abort();
  });
  pi.on("input", (event) => {
    // Tool steps and automatic recovery are not a new user interaction.
    if (state.stats && event.source !== "extension") state.stats = "awaiting-settle";
    return { action: "continue" };
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (state.stats === "awaiting-settle") clearStats(ctx);
  });
  pi.on("session_before_compact", async (event, ctx) => {
    clearStats(ctx);
    const active = state;
    const signal = AbortSignal.any([event.signal, active.lifetime.signal]);
    const run: Run = { started: performance.now(), accounting: { partial: false } };
    active.pending = run;
    const handoff = () => {
      active.pending = undefined;
      notify(ctx, "handing over to Pi's built-in compaction");
      return undefined;
    };
    try {
      signal.throwIfAborted();
      for (; active.cursor < active.config.models.length; active.cursor++) {
        const candidate = active.config.models[active.cursor];
        const slash = candidate.model.indexOf("/");
        const model = ctx.modelRegistry.find(candidate.model.slice(0, slash), candidate.model.slice(slash + 1));
        if (!model) {
          notify(ctx, "skipping " + candidate.model + " — model is not registered", "warning");
          continue;
        }
        const requested = candidate.thinking ?? active.config.defaultThinking;
        const thinking = clampThinkingLevel(model, requested);
        notify(ctx, "compacting with " + candidate.model + " (thinking: " + thinking +
          (thinking === requested ? "" : "; requested: " + requested) + ")");
        try {
          const result = await summarize(event.preparation, event.customInstructions,
            ctx.modelRegistry, model, thinking, active.config.timeout, signal, run.accounting);
          signal.throwIfAborted();
          const evidence = files(event);
          run.result = result;
          run.model = candidate.model;
          run.summary = result.summary + fileText(evidence);
          return { compaction: {
            summary: run.summary, firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore, usage: run.accounting.usage,
            details: { contextScribe: true, ...evidence, model: candidate.model, thinking,
              chunks: result.chunks, requests: result.requests, usagePartial: run.accounting.partial },
          } };
        } catch (error) {
          if (signal.aborted) return { cancel: true };
          notify(ctx, candidate.model + " failed — " + reason(error), "warning");
        }
      }
      return handoff();
    } catch (error) {
      if (signal.aborted) return { cancel: true };
      // An extension bug or unusable preparation must not disable Pi's compactor.
      active.cursor = active.config.models.length;
      notify(ctx, reason(error), "warning");
      return handoff();
    }
  });
  pi.on("session_compact", (event, ctx) => {
    const run = state.pending;
    state.pending = undefined;
    if (!run || !event.fromExtension || run.summary !== event.compactionEntry.summary) return;
    const mode = run.result?.chunks ? "chunked (" + run.result.chunks + "ch/" +
      run.result.requests + "req)" : "direct";
    const model = run.model ?? "unknown";
    if (ctx.mode !== "tui") {
      // RPC clients have no native chat redraw and cannot render widget factories.
      notify(ctx, "compaction complete — " + model + " · " + mode + " · " + statistics(run));
      return;
    }
    const detail = mode + " · " + statistics(run, true);
    try {
      // Widgets live outside chat, which Pi clears after session_compact.
      // Freeze elapsed time now; re-render only adapts text to width/theme.
      ctx.ui.setWidget(STATS_WIDGET, (_tui, theme) => ({
        render: (width) => [theme.fg("dim", completionLine(model, detail, width))],
        invalidate() {},
      }));
      state.stats = "awaiting-input";
    } catch { /* Reporting must never turn successful compaction into failure. */ }
  });
  pi.on("session_compact_failed", (event, ctx) => {
    const run = state.pending;
    state.pending = undefined;
    if (run) notify(ctx, "compaction " + (event.aborted ? "cancelled" : "failed") +
      " · " + statistics(run), event.aborted ? "info" : "warning");
  });
}
