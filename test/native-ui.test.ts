import "./offline.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { harness } from "./helpers.ts";

/**
 * Test-only access to native host wiring. Production uses public ctx.ui only.
 * Keep Pi's actual compaction_end, notify, widget and container methods; stub
 * agent/terminal panels unrelated to the redraw that erased the notification.
 */
test("native Pi redraw preserves the widget through tool turns until the next user response settles", async (t) => {
  const h = await harness(t);
  initTheme("dark", false);
  const mode = Object.create(InteractiveMode.prototype);
  mode.isInitialized = true;
  mode.ui = { requestRender() {} };
  mode.footer = { invalidate() {} };
  mode.programStatus = { handleEvent() {} };
  mode.chatContainer = new Container();
  mode.widgetContainerAbove = new Container();
  mode.widgetContainerBelow = new Container();
  mode.extensionWidgetsAbove = new Map();
  mode.extensionWidgetsBelow = new Map();
  mode.runtimeHost = { session: {
    settingsManager: { getShowTerminalProgress: () => false },
    sessionManager: { buildContextEntries: () => [{ type: "compaction", id: "synthetic" }] },
  } };
  mode.clearStatusIndicator = () => {};
  mode.renderSessionEntries = () => mode.chatContainer.addChild(new Text("Retained conversation"));
  mode.addMessageToChat = () => mode.chatContainer.addChild(new Text("Compaction summary"));
  mode.addCompactionCostNotice = () => mode.chatContainer.addChild(new Text("Pi usage notice"));
  mode.flushCompactionQueue = async () => {};
  h.ctx.ui.notify = (message, type) => mode.showExtensionNotify(message, type);
  h.ctx.ui.setWidget = (key, content, options) => mode.setExtensionWidget(key, content, options);

  const result = await h.before();
  const chat = () => mode.chatContainer.render(120).join("\n");
  assert.match(chat(), /compacting with test\/a/);
  await h.emit("session_compact", { fromExtension: true, compactionEntry: result.compaction });
  // Reproduce the old implementation at the exact pre-redraw boundary.
  mode.showExtensionNotify("Old invisible completion notification", "info");
  assert.match(chat(), /Old invisible completion notification/);
  assert.equal(mode.extensionWidgetsAbove.size, 1);

  await mode.handleEvent({ type: "compaction_end", reason: "manual", result: result.compaction,
    aborted: false, willRetry: false });
  assert.doesNotMatch(chat(), /Old invisible completion notification|context-scribe/);
  assert.match(chat(), /Compaction summary/);
  for (const width of [40, 80, 120]) {
    const lines = mode.widgetContainerAbove.render(width);
    assert.match(lines.join("\n"), /context-scribe:/);
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
  }
  await h.emit("turn_end");
  await h.emit("agent_settled");
  assert.equal(mode.extensionWidgetsAbove.size, 1);
  await h.emit("input", { source: "interactive", text: "Continue" });
  await h.emit("turn_end");
  assert.equal(mode.extensionWidgetsAbove.size, 1);
  await h.emit("agent_settled");
  assert.equal(mode.extensionWidgetsAbove.size, 0);
  assert.doesNotMatch(mode.widgetContainerAbove.render(120).join("\n"), /context-scribe/);
});
