import "./offline.ts";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionUIContext, type SessionCompactEvent, type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import contextScribe from "../src/index.ts";
import { sandbox, widgetUI } from "./helpers.ts";

async function setup(t: TestContext) {
  const { cwd, agent } = await sandbox(t);
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(agent, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false,
  });
  const coding = fauxProvider({ provider: "fake-coding",
    models: [{ id: "coding", contextWindow: 4096, maxTokens: 1024 }] });
  const scribe = fauxProvider({ provider: "fake-scribe",
    models: [{ id: "a", reasoning: true, contextWindow: 64000, maxTokens: 4096 }] });
  runtime.registerNativeProvider(coding.provider);
  runtime.registerNativeProvider(scribe.provider);
  await writeFile(join(cwd, ".pi", "pi-context-scribe.json"), '{"models":["fake-scribe/a"]}');
  const settings = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 128 },
    retry: { enabled: false },
  });
  settings.setProjectTrusted(true);
  const events: SessionCompactEvent[] = [];
  const preparations: SessionBeforeCompactEvent["preparation"][] = [];
  const loader = new DefaultResourceLoader({
    cwd, agentDir: agent, settingsManager: settings, noExtensions: true,
    noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [contextScribe, (pi) => {
      pi.on("session_compact", (event) => { events.push(event); });
      pi.on("session_before_compact", (event) => { preparations.push(event.preparation); });
    }],
  });
  await loader.reload();
  const manager = SessionManager.inMemory(cwd);
  manager.appendMessage({ role: "user", content: "Early constraint: never deploy. " + "x".repeat(15000), timestamp: 0 });
  manager.appendMessage(fauxAssistantMessage("Older work is done."));
  const kept = manager.appendMessage({ role: "user", content: "Recent request " + "r".repeat(800), timestamp: 0 });
  manager.appendMessage(fauxAssistantMessage("Recent retained response"));
  const { session, extensionsResult } = await createAgentSession({
    cwd, agentDir: agent, modelRuntime: runtime, model: coding.getModel(), thinkingLevel: "off",
    sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: "all",
  });
  t.after(() => session.dispose());
  assert.deepEqual(extensionsResult.errors, []);
  const notifications: string[] = [];
  const widget = widgetUI();
  const errors: unknown[] = [];
  await session.bindExtensions({
    mode: "tui",
    uiContext: { setWidget: widget.setWidget,
      notify(message: string) { notifications.push(message); } } as ExtensionUIContext,
    onError: (error) => { errors.push(error); },
  });
  return { session, manager, runtime, coding, scribe, events, preparations, kept, notifications, errors, ...widget };
}

test("real manual lifecycle: selected compaction model, boundary, retained history and usage", async (t) => {
  const h = await setup(t);
  h.scribe.setResponses([fauxAssistantMessage("## Goal\nNever deploy; continue unfinished work.")]);
  const result = await h.session.compact("Preserve the constraint.");
  assert.equal(result.firstKeptEntryId, h.kept);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].fromExtension, true);
  assert.equal(h.scribe.state.callCount, 1);
  assert.equal(h.coding.state.callCount, 0);
  assert.equal(h.session.model?.provider, "fake-coding");
  assert.equal(h.session.thinkingLevel, "off");
  assert.ok(h.session.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("Recent request")));
  assert.ok(result.usage && result.usage.totalTokens > 0);
  assert.match(h.widgetText(), /context-scribe: a · direct/);
  assert.ok(!h.notifications.some((line) => line.includes("compaction complete")));
  await h.session.prompt("/context-scribe");
  assert.equal(h.widgets.size, 1);
  h.coding.setResponses([fauxAssistantMessage("The next user request is complete.")]);
  await h.session.prompt("Continue after manual compaction.");
  assert.equal(h.widgets.size, 0);
  assert.equal(h.widgetUpdates.filter((update) => update.content === undefined).length, 1);
  assert.deepEqual(h.errors, []);
});

test("real manual fallback: failing extension model cannot prevent working Pi compaction; no trailing line", async (t) => {
  const h = await setup(t);
  h.scribe.setResponses([fauxAssistantMessage("unusable", { stopReason: "error", errorMessage: "fake failure" })]);
  h.coding.setResponses([fauxAssistantMessage("## Goal\nPi's checkpoint")]);
  const result = await h.session.compact();
  assert.match(result.summary, /Pi's checkpoint/);
  assert.equal(result.firstKeptEntryId, h.kept);
  assert.equal(h.events[0].fromExtension, false);
  assert.equal(h.coding.state.callCount, 1);
  assert.match(h.notifications.at(-1)!, /handing over to Pi's built-in compaction/);
  assert.ok(!h.notifications.some((line) => line.includes("compaction complete")));
  assert.deepEqual(h.errors, []);
});

test("real automatic threshold lifecycle: failed custom model hands off, then coding continues", async (t) => {
  const h = await setup(t);
  h.scribe.setResponses([fauxAssistantMessage("bad", { stopReason: "error", errorMessage: "fake failure" })]);
  h.coding.setResponses([
    fauxAssistantMessage("## Goal\nPi's automatic checkpoint"),
    fauxAssistantMessage("Continuing the work."),
  ]);
  await h.session.prompt("Continue now.");
  assert.ok(h.events.some((event) => event.reason === "threshold" && !event.fromExtension));
  assert.equal(h.scribe.state.callCount, 1);
  assert.equal(h.coding.state.callCount, 2);
  assert.equal(h.session.getLastAssistantText(), "Continuing the work.");
  assert.equal(h.session.model?.provider, "fake-coding");
  assert.match(h.notifications.at(-1)!, /handing over to Pi's built-in compaction/);
  assert.deepEqual(h.errors, []);
});

test("a second real compaction updates the prior summary without rereading already-discarded history", async (t) => {
  const h = await setup(t);
  h.scribe.setResponses([fauxAssistantMessage("## Goal\nRemember: never deploy.")]);
  await h.session.compact();
  const newest = h.manager.appendMessage({ role: "user", content: "Newest request " + "z".repeat(800), timestamp: 0 });
  h.manager.appendMessage(fauxAssistantMessage("Newest retained response"));
  h.session.refreshContext();
  let secondInput = "";
  h.scribe.setResponses([(context) => {
    const message = context.messages.at(-1)!;
    secondInput = typeof message.content === "string" ? message.content :
      message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    return fauxAssistantMessage("## Goal\nNever deploy; current progress reconciled.");
  }]);
  const result = await h.session.compact();
  assert.equal(result.firstKeptEntryId, h.preparations.at(-1)!.firstKeptEntryId);
  const path = h.manager.getBranch();
  assert.ok(path.findIndex((entry) => entry.id === result.firstKeptEntryId) <=
    path.findIndex((entry) => entry.id === newest));
  assert.match(secondInput, /Remember: never deploy/);
  assert.match(secondInput, /Recent request/);
  assert.doesNotMatch(secondInput, /Early constraint:|Newest request/);
  assert.equal(h.events.length, 2);
  assert.deepEqual(h.errors, []);
});

test("real SDK chunked compaction uses fresh native-provider requests and sums their usage", async (t) => {
  const h = await setup(t);
  // The registry returns the provider's published model definition.
  const published = h.runtime.getModel("fake-scribe", "a")!;
  published.contextWindow = 8000;
  published.maxTokens = 512;
  const reply = () => fauxAssistantMessage("## Goal\nKeep the constraint and current progress.");
  h.scribe.setResponses([reply, reply, reply, reply, reply]);
  const result = await h.session.compact();
  assert.equal(result.firstKeptEntryId, h.kept);
  const details = result.details as { chunks: number; requests: number };
  assert.ok(details.chunks > 1);
  assert.equal(details.requests, details.chunks + 1);
  assert.equal(h.scribe.state.callCount, details.requests);
  assert.equal(h.coding.state.callCount, 0);
  assert.ok(result.usage && result.usage.totalTokens > 0);
  assert.match(h.widgetText(), /context-scribe: a · chunked/);
  assert.deepEqual(h.errors, []);
});

test("real SDK dispatches the read-only status command and its aliases without starting a coding turn", async (t) => {
  const h = await setup(t);
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const entryCount = h.manager.getEntries().length;
  for (const command of ["/context-scribe", "/context-scribe status", "/context-scribe s"]) {
    await h.session.prompt(command);
    assert.ok(h.notifications.at(-1)!.startsWith("context-scribe: v" + manifest.version));
    assert.match(h.notifications.at(-1)!, /Current compaction route: fake-scribe\/a/);
  }
  assert.equal(h.scribe.state.callCount, 0);
  assert.equal(h.coding.state.callCount, 0);
  assert.equal(h.events.length, 0);
  assert.equal(h.manager.getEntries().length, entryCount);
  assert.equal(h.session.model?.provider, "fake-coding");
  assert.deepEqual(h.errors, []);
});

test("real SDK pre-prompt auto-compaction widget lasts until the following user response settles", async (t) => {
  const h = await setup(t);
  h.scribe.setResponses([fauxAssistantMessage("## Goal\nContinue without deployment.")]);
  h.coding.setResponses([
    fauxAssistantMessage("Resumed coding turn complete."),
    fauxAssistantMessage("The next user request is complete."),
  ]);
  let visibleAtEnd = "";
  const unsubscribe = h.session.subscribe((event) => {
    if (event.type === "compaction_end") visibleAtEnd = h.widgetText();
  });
  t.after(unsubscribe);
  await h.session.prompt("Continue.");
  assert.match(visibleAtEnd, /context-scribe: a · direct/);
  assert.equal(h.widgets.size, 1);
  assert.equal(h.widgetUpdates.filter((update) => update.content === undefined).length, 0);
  await h.session.prompt("/context-scribe s");
  assert.equal(h.widgets.size, 1);
  await h.session.prompt("My next request.");
  assert.equal(h.widgets.size, 0);
  assert.equal(h.widgetUpdates.filter((update) => update.content !== undefined).length, 1);
  assert.equal(h.widgetUpdates.filter((update) => update.content === undefined).length, 1);
  assert.deepEqual(h.errors, []);
});

test("real SDK overflow recovery keeps the widget through automatic continuation and the next user request", async (t) => {
  const h = await setup(t);
  // Fit the initial history so compaction happens only after the first model call fails.
  h.session.model!.contextWindow = 64000;
  h.runtime.getModel("fake-coding", "coding")!.contextWindow = 64000;
  h.scribe.setResponses([fauxAssistantMessage("## Goal\nContinue the interrupted request.")]);
  h.coding.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" }),
    fauxAssistantMessage("Recovered request complete."),
    fauxAssistantMessage("The next user request is complete."),
  ]);
  let ends = 0;
  const unsubscribe = h.session.subscribe((event) => {
    if (event.type === "agent_end") ends++;
  });
  t.after(unsubscribe);
  await h.session.prompt("Continue the current request.");
  assert.ok(h.events.some((event) => event.reason === "overflow" && event.willRetry));
  assert.ok(ends >= 2);
  assert.equal(h.session.getLastAssistantText(), "Recovered request complete.");
  assert.match(h.widgetText(), /context-scribe: a · direct/);
  assert.equal(h.widgetUpdates.filter((update) => update.content === undefined).length, 0);
  await h.session.prompt("My next request.");
  assert.equal(h.widgets.size, 0);
  assert.equal(h.widgetUpdates.filter((update) => update.content === undefined).length, 1);
  assert.deepEqual(h.errors, []);
});
