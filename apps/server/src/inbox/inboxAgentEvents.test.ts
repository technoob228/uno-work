import type { OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  INITIAL_INBOX_AGENT_STATE,
  agentItemBody,
  callItemBody,
  trackInboxAgentEvent,
  type InboxAgentAction,
} from "./inboxAgentEvents.ts";

const event = (type: string, payload: unknown): OrchestrationEvent =>
  ({ type, payload, metadata: {} }) as unknown as OrchestrationEvent;

const session = (status: string, extra: Record<string, unknown> = {}, threadId = "t1") =>
  event("thread.session-set", {
    threadId,
    session: { status, activeTurnId: null, lastError: null, ...extra },
  });

const AGENT = { kind: "agent", threadId: "child" };
const fromOrigin = (type: string, payload: unknown, origin: unknown): OrchestrationEvent =>
  ({ type, payload, metadata: { origin } }) as unknown as OrchestrationEvent;

/** A whole turn of `threadId`, started by `origin` (undefined: the person here). */
const turn = (threadId: string, origin?: unknown): OrchestrationEvent[] => [
  fromOrigin("thread.turn-start-requested", { threadId }, origin),
  session("running", { activeTurnId: `${threadId}-turn` }, threadId),
  session("ready", {}, threadId),
];

const posts = (actions: ReadonlyArray<InboxAgentAction>) =>
  actions.filter((action) => action.type === "post" || action.type === "call");

function run(events: ReadonlyArray<OrchestrationEvent>): InboxAgentAction[] {
  let state = INITIAL_INBOX_AGENT_STATE;
  const out: InboxAgentAction[] = [];
  for (const next of events) {
    const tracked = trackInboxAgentEvent(state, next);
    state = tracked.state;
    out.push(...tracked.actions);
  }
  return out;
}

describe("agent events → inbox", () => {
  it("a finished turn posts done (and clears an old error)", () => {
    const actions = run([
      event("thread.turn-start-requested", { threadId: "t1" }),
      session("running", { activeTurnId: "turn1" }),
      session("ready"),
    ]);
    expect(actions).toContainEqual({
      type: "post",
      threadId: "t1",
      kind: "agent.done",
      detail: null,
    });
    expect(actions).toContainEqual({ type: "resolve", threadId: "t1", kinds: ["agent.error"] });
  });

  it("Done on a chat reads its finished/failed news", () => {
    const actions = run([event("thread.settled", { threadId: "t1", settledAt: "x" })]);
    expect(actions).toEqual([
      { type: "resolve", threadId: "t1", kinds: ["agent.done", "agent.error"] },
      { type: "resolve-call", threadId: "t1" },
    ]);
  });

  it("an error posts once with its text", () => {
    const actions = run([
      session("running", { activeTurnId: "turn1" }),
      session("error", { lastError: "rate limited" }),
      session("error", { lastError: "rate limited" }),
    ]);
    expect(actions.filter((action) => action.type === "post")).toEqual([
      { type: "post", threadId: "t1", kind: "agent.error", detail: "rate limited" },
    ]);
  });

  it("approvals and questions post; answering them resolves", () => {
    const actions = run([
      event("thread.activity-appended", {
        threadId: "t1",
        activity: {
          kind: "approval.requested",
          summary: "Run command",
          payload: { detail: "npm i" },
        },
      }),
      event("thread.activity-appended", {
        threadId: "t1",
        activity: {
          kind: "user-input.requested",
          summary: "User input requested",
          payload: { questions: [{ question: "Which bot token?" }] },
        },
      }),
      event("thread.approval-response-requested", { threadId: "t1" }),
      event("thread.activity-appended", {
        threadId: "t1",
        activity: { kind: "user-input.resolved", summary: "", payload: {} },
      }),
    ]);
    expect(actions).toEqual([
      { type: "post", threadId: "t1", kind: "agent.approval", detail: "npm i" },
      { type: "post", threadId: "t1", kind: "agent.input", detail: "Which bot token?" },
      { type: "resolve", threadId: "t1", kinds: ["agent.approval"] },
      { type: "resolve", threadId: "t1", kinds: ["agent.input"] },
    ]);
  });

  it("writes short plain lines", () => {
    expect(agentItemBody("agent.done", null)).toBe("Finished.");
    expect(agentItemBody("agent.input", "Which token?")).toBe("Asks: Which token?");
    expect(callItemBody("Pick a plan")).toBe("Needs you: Pick a plan");
    expect(callItemBody(null)).toBe("Needs you: take a look at this chat.");
  });

  it("a turn another chat's agent started is not news: no Finished", () => {
    const actions = run(turn("t1", AGENT));
    expect(posts(actions)).toEqual([]);
    expect(actions).toContainEqual({ type: "resolve", threadId: "t1", kinds: ["agent.error"] });
  });

  it("the person's turn through Telegram or an automation is news", () => {
    const telegram = { kind: "connector", connector: "telegram" };
    const automation = { kind: "system", component: "automations" };
    expect(posts(run(turn("t1", telegram)))).toHaveLength(1);
    expect(posts(run(turn("t1", automation)))).toHaveLength(1);
    expect(posts(run(turn("t1", { kind: "manager", tokenId: "x" })))).toEqual([]);
  });

  it("an agent writing to the chat does not read the person's Finished for them", () => {
    const actions = run([fromOrigin("thread.turn-start-requested", { threadId: "t1" }, AGENT)]);
    expect(actions).toEqual([]);
  });

  it("a call posts Needs you; writing there, Done or not-needed takes it back", () => {
    const called = event("thread.person-called", { threadId: "t1", reason: " Pick a plan " });
    expect(run([called])).toEqual([{ type: "call", threadId: "t1", reason: "Pick a plan" }]);
    expect(run([event("thread.person-called", { threadId: "t1", reason: null })])).toEqual([
      { type: "call", threadId: "t1", reason: null },
    ]);
    expect(run([event("thread.person-released", { threadId: "t1" })])).toEqual([
      { type: "resolve-call", threadId: "t1" },
    ]);
    expect(run([event("thread.turn-start-requested", { threadId: "t1" })])).toContainEqual({
      type: "resolve-call",
      threadId: "t1",
    });
    expect(run([event("thread.settled", { threadId: "t1" })])).toContainEqual({
      type: "resolve-call",
      threadId: "t1",
    });
    expect(
      run([fromOrigin("thread.turn-start-requested", { threadId: "t1" }, AGENT)]),
    ).not.toContainEqual({ type: "resolve-call", threadId: "t1" });
  });

  it("safety net: the person's request that waited on its chats is Finished when the last is done", () => {
    const asked = event("thread.message-sent", {
      threadId: "parent",
      role: "user",
      createdAt: "2026-11-13T10:00:00.000Z",
    });
    const spawned = (threadId: string) =>
      fromOrigin(
        "thread.created",
        { threadId, spawnedByThreadId: "parent", createdAt: "2026-11-13T10:01:00.000Z" },
        { kind: "agent", threadId: "parent" },
      );
    const actions = run([
      asked,
      spawned("a"),
      spawned("b"),
      session("running", { activeTurnId: "a1" }, "a"),
      session("running", { activeTurnId: "b1" }, "b"),
      session("ready", {}, "a"),
      // a reports back while b still works: not yet.
      ...turn("parent", { kind: "agent", threadId: "a" }),
      session("ready", {}, "b"),
      // b reports back, nothing runs any more: the request is answered.
      ...turn("parent", { kind: "agent", threadId: "b" }),
    ]);
    expect(posts(actions).filter((action) => action.threadId === "parent")).toEqual([
      { type: "post", threadId: "parent", kind: "agent.done", detail: null },
    ]);
  });

  it("safety net: chats started before the person's latest message do not count", () => {
    const actions = run([
      fromOrigin(
        "thread.created",
        { threadId: "old", spawnedByThreadId: "parent", createdAt: "2026-11-12T10:00:00.000Z" },
        { kind: "agent", threadId: "parent" },
      ),
      event("thread.message-sent", {
        threadId: "parent",
        role: "user",
        createdAt: "2026-11-13T10:00:00.000Z",
      }),
      ...turn("parent", AGENT),
    ]);
    expect(posts(actions)).toEqual([]);
  });
});
