import type { OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  INITIAL_INBOX_AGENT_STATE,
  agentItemBody,
  trackInboxAgentEvent,
  type InboxAgentAction,
} from "./inboxAgentEvents.ts";

const event = (type: string, payload: unknown): OrchestrationEvent =>
  ({ type, payload, metadata: {} }) as unknown as OrchestrationEvent;

const session = (status: string, extra: Record<string, unknown> = {}) =>
  event("thread.session-set", {
    threadId: "t1",
    session: { status, activeTurnId: null, lastError: null, ...extra },
  });

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
  });
});
