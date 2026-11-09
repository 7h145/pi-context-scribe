import "./offline.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { contentText, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, ModelRegistry, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import contextScribe from "../src/index.ts";

export function model(id = "a", contextWindow = 64000, maxTokens = 16000): Model<any> {
  return { provider: "test", id, name: id, api: "openai-completions", baseUrl: "https://invalid.example",
    reasoning: true, input: ["text"], contextWindow, maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
export function response(text = "## Goal\nContinue safely", stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions",
    provider: "test", model: "a", stopReason, timestamp: 0,
    usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, totalTokens: 135,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
export function preparation(text = "Do the agreed work.", reserveTokens = 16384): SessionBeforeCompactEvent["preparation"] {
  return { firstKeptEntryId: "keep-boundary", messagesToSummarize: [{ role: "user", content: text, timestamp: 0 }],
    turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 50000,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens, keepRecentTokens: 20000 } };
}
export function prompt(context: Context): string {
  return contentText(context.messages.at(-1)!.content);
}
export interface Call {
  model: Model<any>;
  context: Context;
  options: SimpleStreamOptions;
}
export function registry(reply: (call: Call, index: number) => AssistantMessage | Promise<AssistantMessage>) {
  const calls: Call[] = [];
  return {
    calls,
    streamSimple(m: Model<any>, context: Context, options: SimpleStreamOptions = {}) {
      const call = { model: m, context, options };
      calls.push(call);
      return { result: () => Promise.resolve().then(() => reply(call, calls.length - 1)) } as
        ReturnType<ModelRegistry["streamSimple"]>;
    },
  };
}
export async function sandbox(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "context-scribe-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project"), agent = join(root, "agent");
  await Promise.all([mkdir(join(cwd, ".pi"), { recursive: true }), mkdir(agent)]);
  return { cwd, agent, root };
}
type Widget = Exclude<Parameters<ExtensionUIContext["setWidget"]>[1], undefined>;
export function widgetUI() {
  const widgets = new Map<string, Widget>();
  const widgetUpdates: { key: string; content: Widget | undefined }[] = [];
  return {
    widgets, widgetUpdates,
    setWidget(key: string, content: Widget | undefined) {
      widgetUpdates.push({ key, content });
      if (content === undefined) widgets.delete(key); else widgets.set(key, content);
    },
    widgetText(width = 160): string {
      return [...widgets.values()].flatMap((factory) => factory({} as Parameters<Widget>[0],
        { fg: (_color: string, value: string) => value } as unknown as Parameters<Widget>[1]).render(width)).join("\n");
    },
  };
}
export async function harness(t: TestContext, config: unknown = { models: ["test/a", "test/b"] }) {
  const box = await sandbox(t);
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = box.agent;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  const path = join(box.cwd, ".pi", "pi-context-scribe.json");
  await writeFile(path, JSON.stringify(config));
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const commands = new Map<string, { handler(args: string, ctx: any): Promise<void> }>();
  const pi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => any) { handlers.set(name, handler); },
    registerCommand(name: string, command: { handler(args: string, ctx: any): Promise<void> }) { commands.set(name, command); },
  };
  contextScribe(pi as unknown as ExtensionAPI);
  const notifications: { message: string; type: string | undefined }[] = [];
  const widget = widgetUI();
  const models = new Map(["a", "b", "coding"].map((id) => [id, model(id)]));
  let reply = async (_call: Call, _index: number) => response();
  const mock = registry((call, index) => reply(call, index));
  const ctx = { cwd: box.cwd, mode: "tui", hasUI: true, isProjectTrusted: () => true, model: models.get("coding"),
    ui: { setWidget: widget.setWidget,
      notify(message: string, type?: string) { notifications.push({ message, type }); } },
    modelRegistry: { ...mock, find(provider: string, id: string) { return provider === "test" ? models.get(id) : undefined; } },
  } as unknown as ExtensionContext;
  const emit = (name: string, event: any = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
  await emit("session_start", { reason: "startup" });
  return { ...box, ...widget, path, ctx, models, calls: mock.calls, notifications, emit,
    command(args = "") { return commands.get("context-scribe")!.handler(args, ctx); },
    setReply(fn: typeof reply) { reply = fn; },
    before(prep = preparation(), signal = new AbortController().signal) {
      return emit("session_before_compact", { preparation: prep, branchEntries: [], signal, reason: "manual", willRetry: false });
    } };
}
