import type {
  EnvironmentId,
  OrchestrationShellStreamEvent,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ShellEventNotice } from "../../environments/runtime/shellEventBus";
import {
  createPanelBridge,
  DEFAULT_PANEL_BRIDGE_RATE_LIMIT,
  parsePanelRequest,
  shellEventToPanelEvent,
  type PanelBridgeEventMessage,
  type PanelBridgeResponse,
} from "./panelBridge";

const environmentId = "env-primary" as EnvironmentId;
const projectId = "project-1" as ProjectId;

function makeBridge(overrides?: {
  readonly sendToThread?: (params: { text: string; threadTag?: string }) => unknown;
  readonly now?: () => number;
}) {
  const posted: Array<PanelBridgeResponse | PanelBridgeEventMessage> = [];
  const openFile = vi.fn();
  const openUrl = vi.fn();
  const sendToThread = vi.fn(
    overrides?.sendToThread ?? (() => ({ threadId: "thread-1", created: true })),
  );
  const bridge = createPanelBridge({
    post: (message) => posted.push(message),
    methods: { openFile, openUrl, sendToThread },
    ...(overrides?.now ? { now: overrides.now } : {}),
  });
  return { bridge, posted, openFile, openUrl, sendToThread };
}

const call = (method: string, params?: unknown, id: string | number = 1) => ({
  __unoPanel: 1,
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("parsePanelRequest", () => {
  it("accepts only well-formed protocol messages", () => {
    expect(parsePanelRequest(call("openUrl", { url: "https://example.com" }))).toEqual({
      id: 1,
      method: "openUrl",
      params: { url: "https://example.com" },
    });
    // Чужие postMessage (расширения, вебпак-девсервер и т.п.) игнорируем.
    expect(parsePanelRequest({ type: "webpackOk" })).toBeNull();
    expect(parsePanelRequest({ __unoPanel: 2, id: 1, method: "openUrl" })).toBeNull();
    expect(parsePanelRequest({ __unoPanel: 1, method: "openUrl" })).toBeNull();
    expect(parsePanelRequest({ __unoPanel: 1, id: 1 })).toBeNull();
    expect(parsePanelRequest("nope")).toBeNull();
  });
});

describe("panel bridge method dictionary", () => {
  it("dispatches the v1 methods and answers with a result", async () => {
    const { bridge, posted, openFile, openUrl, sendToThread } = makeBridge();

    bridge.handleMessage(call("openFile", { path: "notes.md" }, "a"));
    bridge.handleMessage(call("openUrl", { url: "https://example.com" }, "b"));
    bridge.handleMessage(call("sendToThread", { text: "почини тесты" }, "c"));
    await flush();

    expect(openFile).toHaveBeenCalledWith({ path: "notes.md" });
    expect(openUrl).toHaveBeenCalledWith({ url: "https://example.com" });
    expect(sendToThread).toHaveBeenCalledWith({ text: "почини тесты" });
    expect(posted).toEqual([
      { __unoPanel: 1, id: "a", result: { ok: true } },
      { __unoPanel: 1, id: "b", result: { ok: true } },
      { __unoPanel: 1, id: "c", result: { threadId: "thread-1", created: true } },
    ]);
  });

  it("rejects unknown methods and malformed params", async () => {
    const { bridge, posted } = makeBridge();

    bridge.handleMessage(call("evalJs", { code: "1" }, "x"));
    bridge.handleMessage(call("openFile", {}, "y"));
    bridge.handleMessage(call("sendToThread", { text: "  " }, "z"));
    await flush();

    expect(posted).toHaveLength(3);
    expect(posted[0]).toEqual({ __unoPanel: 1, id: "x", error: 'unknown method "evalJs"' });
    expect(posted[1]).toMatchObject({ id: "y", error: '"path" must be a non-empty string' });
    expect(posted[2]).toMatchObject({ id: "z", error: '"text" must be a non-empty string' });
  });

  it("reports a failing host method as an error response", async () => {
    const { bridge, posted } = makeBridge({
      sendToThread: () => {
        throw new Error("нет открытого проекта");
      },
    });

    bridge.handleMessage(call("sendToThread", { text: "привет" }, 7));
    await flush();

    expect(posted).toEqual([{ __unoPanel: 1, id: 7, error: "нет открытого проекта" }]);
  });
});

describe("panel bridge rate limit", () => {
  it("rejects calls above the per-second budget and recovers after the window", async () => {
    let clock = 1_000;
    const { bridge, posted, openUrl } = makeBridge({ now: () => clock });

    for (let index = 0; index < DEFAULT_PANEL_BRIDGE_RATE_LIMIT + 3; index += 1) {
      bridge.handleMessage(call("openUrl", { url: "https://example.com" }, index));
    }
    await flush();

    expect(openUrl).toHaveBeenCalledTimes(DEFAULT_PANEL_BRIDGE_RATE_LIMIT);
    const errors = posted.filter((message) => "error" in message);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatchObject({ error: expect.stringContaining("rate limit") });

    clock += 1_001;
    bridge.handleMessage(call("openUrl", { url: "https://example.com" }, "later"));
    await flush();
    expect(openUrl).toHaveBeenCalledTimes(DEFAULT_PANEL_BRIDGE_RATE_LIMIT + 1);
  });
});

describe("panel bridge subscriptions", () => {
  const threadEvent = {
    type: "thread.upserted",
    projectId,
    payload: { threadId: "thread-1" },
  } as const;
  const projectEvent = {
    type: "project.upserted",
    projectId,
    payload: { projectId },
  } as const;

  it("emits nothing until the panel subscribes", () => {
    const { bridge, posted } = makeBridge();
    bridge.emitEvent(threadEvent);
    expect(posted).toEqual([]);
  });

  it("filters events by the subscribed patterns", async () => {
    const { bridge, posted } = makeBridge();
    bridge.handleMessage(call("subscribe", { pattern: "thread.*" }, "s"));
    await flush();
    expect(bridge.subscriptions()).toEqual(["thread.*"]);

    bridge.emitEvent(threadEvent);
    bridge.emitEvent(projectEvent);

    const events = posted.filter((message) => "event" in message);
    expect(events).toEqual([{ __unoPanel: 1, event: threadEvent }]);
  });

  it("supports the catch-all pattern and de-duplicates patterns", async () => {
    const { bridge, posted } = makeBridge();
    bridge.handleMessage(call("subscribe", { pattern: "*" }, 1));
    bridge.handleMessage(call("subscribe", { pattern: "*" }, 2));
    await flush();
    expect(bridge.subscriptions()).toEqual(["*"]);

    bridge.emitEvent(projectEvent);
    expect(posted.filter((message) => "event" in message)).toHaveLength(1);
  });
});

describe("shellEventToPanelEvent", () => {
  const notice = (
    event: OrchestrationShellStreamEvent,
    removedThreadProjectId: ProjectId | null = null,
  ): ShellEventNotice => ({ event, environmentId, removedThreadProjectId });

  const threadShell = {
    id: "thread-1" as ThreadId,
    projectId,
    title: "Работа",
    runtimeMode: "approval-required",
    latestTurn: null,
    archivedAt: null,
    hasPendingApprovals: false,
    updatedAt: "2026-08-24T10:00:00.000Z",
  } as unknown as Extract<OrchestrationShellStreamEvent, { kind: "thread-upserted" }>["thread"];

  it("translates shell projection events into the dotted panel vocabulary", () => {
    expect(
      shellEventToPanelEvent(notice({ kind: "thread-upserted", sequence: 1, thread: threadShell })),
    ).toMatchObject({ type: "thread.upserted", projectId });

    expect(
      shellEventToPanelEvent(
        notice(
          { kind: "thread-removed", sequence: 2, threadId: "thread-1" as ThreadId },
          projectId,
        ),
      ),
    ).toMatchObject({ type: "thread.removed", projectId });

    expect(
      shellEventToPanelEvent(notice({ kind: "project-removed", sequence: 3, projectId })),
    ).toMatchObject({ type: "project.removed", projectId });
  });

  it("drops a removed thread whose project is unknown (cannot scope it to the tab)", () => {
    expect(
      shellEventToPanelEvent(
        notice({ kind: "thread-removed", sequence: 4, threadId: "thread-9" as ThreadId }),
      ),
    ).toBeNull();
  });
});
