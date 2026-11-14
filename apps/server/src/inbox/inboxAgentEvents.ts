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
 *
 * A turn that answered the person's own message posts "Answer to your
 * question" (Misha 13.11): it waits for them until they open the chat, write
 * there or press Done — the turns agents take in the chat after it don't
 * touch it, so a person who asked and left finds their answer.
 *
 * Agents talking among themselves are not news (Misha 13.11): a turn another
 * chat's agent (or Uno, an app) started posts no "Finished" — unless the
 * chat is the person's request that waited for the chats it started and the
 * last of them is done (the safety net for an agent that forgot to call the
 * person). An agent calling the person in (`chat_call_person`) is news of
 * its own: "Needs you", until they look at the chat, write there, press
 * Done or the agent says they are no longer needed.
 */
import {
  INBOX_PERSON_ANSWER_BODY_PREFIX,
  INBOX_PERSON_CALL_BODY_PREFIX,
  type InboxItemKind,
  type OrchestrationEvent,
  type ThreadId,
} from "@t3tools/contracts";

import {
  INITIAL_NOTIFY_TRACKER_STATE,
  trackDomainEvent,
  type NotifyTrackerState,
} from "../manager/connectorNotify.ts";
import { isOnPersonsBehalf } from "../orchestration/commandOrigin.ts";

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
      /** A turn answered the person's own message: "Answer to your question". */
      readonly type: "answer";
      readonly threadId: ThreadId;
    }
  | {
      /** An agent called the person into the chat ("Needs you"), with its reason. */
      readonly type: "call";
      readonly threadId: ThreadId;
      readonly reason: string | null;
    }
  | {
      /** These kinds of the thread's items are no longer news: mark them read. */
      readonly type: "resolve";
      readonly threadId: ThreadId;
      readonly kinds: ReadonlyArray<InboxItemKind>;
    }
  | {
      /** The call into the chat is answered or taken back. */
      readonly type: "resolve-call";
      readonly threadId: ThreadId;
    };

interface ChildChat {
  readonly threadId: ThreadId;
  readonly createdAt: string;
}

export interface InboxAgentTrackerState {
  readonly notify: NotifyTrackerState;
  /** The latest message the person (or their automation) sent, per chat. */
  readonly personAskedAt: ReadonlyMap<ThreadId, string>;
  /** Chats an agent started from a chat, per parent (since this daemon started). */
  readonly children: ReadonlyMap<ThreadId, ReadonlyArray<ChildChat>>;
}

export const INITIAL_INBOX_AGENT_STATE: InboxAgentTrackerState = {
  notify: INITIAL_NOTIFY_TRACKER_STATE,
  personAskedAt: new Map(),
  children: new Map(),
};

export function inboxGroupKey(threadId: string, kind: InboxItemKind): string {
  return `agent:${threadId}:${kind}`;
}

/** The answer to the person's message: its own item, apart from the chat's "Finished". */
export function inboxAnswerGroupKey(threadId: string): string {
  return `agent:${threadId}:answer`;
}

/** The person called into a chat: its own item, apart from the chat's questions. */
export function inboxCallGroupKey(threadId: string): string {
  return `agent:${threadId}:call`;
}

/**
 * A turn an agent started in a chat where the person asked something and the
 * chats started for it are all done: the request is answered, even though
 * the agent did not say so.
 */
function waitedOnChildrenAndTheyAreDone(state: InboxAgentTrackerState, threadId: ThreadId) {
  const askedAt = state.personAskedAt.get(threadId);
  if (askedAt === undefined) return false;
  const since = (state.children.get(threadId) ?? []).filter((child) => child.createdAt >= askedAt);
  if (since.length === 0) return false;
  return since.every((child) => {
    const status = state.notify.sessionStatus.get(child.threadId);
    return status !== "running" && status !== "starting";
  });
}

function withoutThread(state: InboxAgentTrackerState, threadId: ThreadId): InboxAgentTrackerState {
  if (!state.personAskedAt.has(threadId) && !state.children.has(threadId)) return state;
  const personAskedAt = new Map(state.personAskedAt);
  const children = new Map(state.children);
  personAskedAt.delete(threadId);
  children.delete(threadId);
  return { ...state, personAskedAt, children };
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
  let next: InboxAgentTrackerState = { ...state, notify: tracked.state };
  const actions: InboxAgentAction[] = [];
  const notification = tracked.notification;
  if (notification !== null) {
    switch (notification.kind) {
      case "turn.completed":
        actions.push({ type: "resolve", threadId: notification.threadId, kinds: ["agent.error"] });
        // Agents talking among themselves are not news for the person.
        if (isOnPersonsBehalf(notification.origin)) {
          actions.push({ type: "answer", threadId: notification.threadId });
        } else if (waitedOnChildrenAndTheyAreDone(next, notification.threadId)) {
          actions.push({
            type: "post",
            threadId: notification.threadId,
            kind: "agent.done",
            detail: null,
          });
        }
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
      // The person is back in the chat: its old news is read, a call answered.
      // Another agent writing there does not read the person's news for them.
      if (isOnPersonsBehalf(event.metadata.origin)) {
        actions.push(
          {
            type: "resolve",
            threadId: event.payload.threadId,
            kinds: ["agent.done", "agent.error"],
          },
          { type: "resolve-call", threadId: event.payload.threadId },
        );
      }
      break;
    case "thread.settled":
      // Done from the sidebar, the chat header or Home: its news is dealt with.
      actions.push(
        { type: "resolve", threadId: event.payload.threadId, kinds: ["agent.done", "agent.error"] },
        { type: "resolve-call", threadId: event.payload.threadId },
      );
      break;
    case "thread.person-called":
      actions.push({
        type: "call",
        threadId: event.payload.threadId,
        reason: event.payload.reason?.trim().slice(0, DETAIL_MAX) || null,
      });
      break;
    case "thread.person-released":
      actions.push({ type: "resolve-call", threadId: event.payload.threadId });
      break;
    case "thread.message-sent": {
      const { threadId, role, createdAt } = event.payload;
      if (role === "user" && isOnPersonsBehalf(event.metadata.origin)) {
        if ((next.personAskedAt.get(threadId) ?? "") < createdAt) {
          const personAskedAt = new Map(next.personAskedAt);
          personAskedAt.set(threadId, createdAt);
          next = { ...next, personAskedAt };
        }
      }
      break;
    }
    case "thread.created": {
      const parent = event.payload.spawnedByThreadId;
      if (parent !== undefined) {
        const children = new Map(next.children);
        children.set(parent, [
          ...(children.get(parent) ?? []),
          { threadId: event.payload.threadId, createdAt: event.payload.createdAt },
        ]);
        next = { ...next, children };
      }
      break;
    }
    case "thread.deleted":
    case "thread.archived":
      next = withoutThread(next, event.payload.threadId);
      break;
    default:
      break;
  }
  return { state: next, actions };
}

/** The line under the chat's title for the answer to the person's message. */
export function answerItemBody(detail: string | null): string {
  return detail
    ? `${INBOX_PERSON_ANSWER_BODY_PREFIX}: ${detail}`
    : `${INBOX_PERSON_ANSWER_BODY_PREFIX} is in.`;
}

/** The line under the chat's title for a call into it. */
export function callItemBody(reason: string | null): string {
  return `${INBOX_PERSON_CALL_BODY_PREFIX}${reason ?? "take a look at this chat."}`;
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
