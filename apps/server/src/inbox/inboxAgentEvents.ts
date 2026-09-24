/**
 * Agent events → Inbox, the pure half.
 *
 * Folds the orchestration event stream into what the person should hear
 * about: a finished turn, an approval or a question the agent waits on, and
 * a chat that failed. Reuses the connector notifier's tracker
 * (`manager/connectorNotify.ts`) for the first three, so Telegram/Slack and
 * the Inbox agree on what "finished" and "failed" mean, and adds questions
 * (`user-input.requested`) plus the moments an item stops being news: the
 * person answered, approved, or wrote to the chat again.
 */
import type { InboxItemKind, OrchestrationEvent, ThreadId } from "@t3tools/contracts";

import {
  INITIAL_NOTIFY_TRACKER_STATE,
  trackDomainEvent,
  type NotifyTrackerState,
} from "../manager/connectorNotify.ts";

const DETAIL_MAX = 280;

export type InboxAgentAction =
  | {
      readonly type: "post";
      readonly threadId: ThreadId;
      readonly kind: Exclude<InboxItemKind, "app">;
      /** Extra line under the chat's title; the service adds the title. */
      readonly detail: string | null;
    }
  | {
      /** These kinds of the thread's items are no longer news: mark them read. */
      readonly type: "resolve";
      readonly threadId: ThreadId;
      readonly kinds: ReadonlyArray<InboxItemKind>;
    };

export interface InboxAgentTrackerState {
  readonly notify: NotifyTrackerState;
}

export const INITIAL_INBOX_AGENT_STATE: InboxAgentTrackerState = {
  notify: INITIAL_NOTIFY_TRACKER_STATE,
};

export function inboxGroupKey(threadId: string, kind: InboxItemKind): string {
  return `agent:${threadId}:${kind}`;
}

function firstQuestion(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const questions = (payload as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return null;
  for (const entry of questions) {
    if (typeof entry === "string" && entry.trim()) return entry.trim().slice(0, DETAIL_MAX);
    if (typeof entry === "object" && entry !== null) {
      const record = entry as Record<string, unknown>;
      for (const field of ["question", "prompt", "header", "text"]) {
        const value = record[field];
        if (typeof value === "string" && value.trim()) return value.trim().slice(0, DETAIL_MAX);
      }
    }
  }
  return null;
}

export function trackInboxAgentEvent(
  state: InboxAgentTrackerState,
  event: OrchestrationEvent,
): { readonly state: InboxAgentTrackerState; readonly actions: ReadonlyArray<InboxAgentAction> } {
  const tracked = trackDomainEvent(state.notify, event);
  const next: InboxAgentTrackerState = { notify: tracked.state };
  const actions: InboxAgentAction[] = [];
  const notification = tracked.notification;
  if (notification !== null) {
    switch (notification.kind) {
      case "turn.completed":
        actions.push(
          { type: "resolve", threadId: notification.threadId, kinds: ["agent.error"] },
          { type: "post", threadId: notification.threadId, kind: "agent.done", detail: null },
        );
        break;
      case "turn.error":
        actions.push({
          type: "post",
          threadId: notification.threadId,
          kind: "agent.error",
          detail: notification.errorText?.slice(0, DETAIL_MAX) ?? null,
        });
        break;
      case "approval.requested":
        actions.push({
          type: "post",
          threadId: notification.threadId,
          kind: "agent.approval",
          detail: (notification.detail ?? notification.summary).slice(0, DETAIL_MAX),
        });
        break;
    }
  }

  switch (event.type) {
    case "thread.activity-appended": {
      const { threadId, activity } = event.payload;
      if (activity.kind === "user-input.requested") {
        actions.push({
          type: "post",
          threadId,
          kind: "agent.input",
          detail: firstQuestion(activity.payload),
        });
      } else if (activity.kind === "user-input.resolved") {
        actions.push({ type: "resolve", threadId, kinds: ["agent.input"] });
      } else if (activity.kind === "approval.resolved") {
        actions.push({ type: "resolve", threadId, kinds: ["agent.approval"] });
      }
      break;
    }
    case "thread.approval-response-requested":
      actions.push({
        type: "resolve",
        threadId: event.payload.threadId,
        kinds: ["agent.approval"],
      });
      break;
    case "thread.user-input-response-requested":
      actions.push({ type: "resolve", threadId: event.payload.threadId, kinds: ["agent.input"] });
      break;
    case "thread.turn-start-requested":
      // The person (or whoever) is back in the chat: its old news is read.
      actions.push({
        type: "resolve",
        threadId: event.payload.threadId,
        kinds: ["agent.done", "agent.error"],
      });
      break;
    default:
      break;
  }
  return { state: next, actions };
}

/** The line under the chat's title in the Inbox. */
export function agentItemBody(kind: Exclude<InboxItemKind, "app">, detail: string | null): string {
  switch (kind) {
    case "agent.done":
      return detail ? `Finished — ${detail}` : "Finished.";
    case "agent.error":
      return detail ? `Stopped with an error: ${detail}` : "Stopped with an error.";
    case "agent.approval":
      return detail ? `Waits for your OK: ${detail}` : "Waits for your OK.";
    case "agent.input":
      return detail ? `Asks: ${detail}` : "Asks you a question.";
  }
}
