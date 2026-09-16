import { assert, describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommandOrigin,
  type OrchestrationEvent,
  type OrchestrationSession,
} from "@t3tools/contracts";

import type { ResolvedNotifyChat } from "./connectorBindings.ts";
import {
  resolveNotifyThreadId,
  admitNotification,
  formatNotificationText,
  INITIAL_NOTIFY_TRACKER_STATE,
  isOwnOriginChat,
  NOTIFY_RATE_LIMIT_MS,
  selectNotificationChats,
  trackDomainEvent,
  type NotifyTrackerState,
} from "./connectorNotify.ts";

const threadId = ThreadId.make("thread-1");
const nowIso = "2026-09-11T10:00:00.000Z";
let sequence = 0;

const base = (origin?: OrchestrationCommandOrigin) => ({
  sequence: ++sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: nowIso,
  commandId: CommandId.make(`command-${sequence}`),
  causationEventId: null,
  correlationId: null,
  metadata: origin === undefined ? {} : { origin },
});

const turnStarted = (origin?: OrchestrationCommandOrigin): OrchestrationEvent => ({
  ...base(origin),
  type: "thread.turn-start-requested",
  payload: {
    threadId,
    messageId: MessageId.make("message-1"),
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: nowIso,
  },
});

const sessionSet = (session: Partial<OrchestrationSession>): OrchestrationEvent => ({
  ...base(),
  type: "thread.session-set",
  payload: {
    threadId,
    session: {
      threadId,
      status: "ready",
      providerName: "claude",
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      updatedAt: nowIso,
      ...session,
    },
  },
});

const activity = (kind: string, payload: unknown): OrchestrationEvent => ({
  ...base(),
  type: "thread.activity-appended",
  payload: {
    threadId,
    activity: {
      id: EventId.make(`activity-${sequence}`),
      tone: "approval",
      kind,
      summary: "Command approval requested",
      payload,
      turnId: TurnId.make("turn-1"),
      createdAt: nowIso,
    },
  },
});

const telegramOrigin: OrchestrationCommandOrigin = {
  kind: "connector",
  connector: "telegram",
  externalActorId: "100",
};

const fold = (events: ReadonlyArray<OrchestrationEvent>, initial = INITIAL_NOTIFY_TRACKER_STATE) =>
  events.reduce<{
    state: NotifyTrackerState;
    notifications: Array<NonNullable<ReturnType<typeof trackDomainEvent>["notification"]>>;
  }>(
    (acc, event) => {
      const next = trackDomainEvent(acc.state, event);
      return {
        state: next.state,
        notifications:
          next.notification === null
            ? acc.notifications
            : [...acc.notifications, next.notification],
      };
    },
    { state: initial, notifications: [] },
  );

describe("trackDomainEvent", () => {
  it("reports a completed turn once, tagged with the origin of the turn that ran", () => {
    const { notifications } = fold([
      turnStarted(telegramOrigin),
      sessionSet({ status: "running", activeTurnId: TurnId.make("turn-1") }),
      sessionSet({ status: "running", activeTurnId: TurnId.make("turn-1") }),
      sessionSet({ status: "ready" }),
      sessionSet({ status: "ready" }),
    ]);
    expect(notifications).toEqual([{ kind: "turn.completed", threadId, origin: telegramOrigin }]);
  });

  it("reports an error with class and text, and not again while the session stays in error", () => {
    const { notifications } = fold([
      turnStarted(),
      sessionSet({ status: "running", activeTurnId: TurnId.make("turn-1") }),
      sessionSet({
        status: "error",
        lastError: "insufficient credit",
        lastErrorClass: "billing_error",
      }),
      sessionSet({
        status: "error",
        lastError: "insufficient credit",
        lastErrorClass: "billing_error",
      }),
    ]);
    expect(notifications).toEqual([
      {
        kind: "turn.error",
        threadId,
        origin: undefined,
        errorClass: "billing_error",
        errorText: "insufficient credit",
      },
    ]);
  });

  it("does not read idle → ready or an interruption as a completed turn", () => {
    expect(fold([sessionSet({ status: "ready" })]).notifications).toEqual([]);
    expect(
      fold([
        sessionSet({ status: "running", activeTurnId: TurnId.make("turn-1") }),
        sessionSet({ status: "interrupted" }),
      ]).notifications,
    ).toEqual([]);
  });

  it("turns an approval.requested activity into a notification with its detail", () => {
    const { notifications } = fold([
      turnStarted(telegramOrigin),
      activity("approval.requested", {
        requestId: ApprovalRequestId.make("req-1"),
        detail: "rm -rf build",
      }),
      activity("approval.resolved", { requestId: ApprovalRequestId.make("req-1") }),
    ]);
    expect(notifications).toEqual([
      {
        kind: "approval.requested",
        threadId,
        origin: telegramOrigin,
        summary: "Command approval requested",
        detail: "rm -rf build",
      },
    ]);
  });

  it("forgets a deleted thread", () => {
    const { state } = fold([
      turnStarted(telegramOrigin),
      sessionSet({ status: "running" }),
      {
        ...base(),
        type: "thread.deleted",
        payload: { threadId, deletedAt: nowIso },
      },
    ]);
    expect(state.turnOrigins.has(threadId)).toBe(false);
    expect(state.sessionStatus.has(threadId)).toBe(false);
  });
});

describe("selectNotificationChats", () => {
  const chat = (overrides: Partial<ResolvedNotifyChat>): ResolvedNotifyChat => ({
    kind: "telegram",
    connectorProjectId: ProjectId.make("assistant-home"),
    chatId: "100",
    notifyOnComplete: false,
    via: "thread",
    ...overrides,
  });

  it("sends completions only to bindings that opted in", () => {
    const chats = [chat({ chatId: "100" }), chat({ chatId: "200", notifyOnComplete: true })];
    expect(
      selectNotificationChats(chats, { kind: "turn.completed", threadId, origin: undefined }).map(
        (c) => c.chatId,
      ),
    ).toEqual(["200"]);
  });

  it("skips the chat that started the turn for errors and completions, but not for approvals", () => {
    const chats = [chat({ chatId: "100", notifyOnComplete: true }), chat({ chatId: "200" })];
    expect(
      selectNotificationChats(chats, {
        kind: "turn.error",
        threadId,
        origin: telegramOrigin,
        errorClass: null,
        errorText: "boom",
      }).map((c) => c.chatId),
    ).toEqual(["200"]);
    expect(
      selectNotificationChats(chats, {
        kind: "approval.requested",
        threadId,
        origin: telegramOrigin,
        summary: "Command approval requested",
        detail: null,
      }).map((c) => c.chatId),
    ).toEqual(["100", "200"]);
    expect(isOwnOriginChat(telegramOrigin, { kind: "slack", chatId: "100" })).toBe(false);
    expect(
      isOwnOriginChat({ kind: "system", component: "x" }, { kind: "telegram", chatId: "100" }),
    ).toBe(false);
  });
});

describe("formatNotificationText", () => {
  it("renders the three kinds", () => {
    expect(
      formatNotificationText(
        {
          kind: "turn.error",
          threadId,
          origin: undefined,
          errorClass: "billing_error",
          errorText: "no credit",
        },
        "Fix billing",
      ),
    ).toBe('Turn failed in "Fix billing" [billing_error]: no credit');
    expect(
      formatNotificationText(
        { kind: "turn.error", threadId, origin: undefined, errorClass: null, errorText: null },
        "Fix billing",
      ),
    ).toBe('Turn failed in "Fix billing".');
    expect(
      formatNotificationText(
        {
          kind: "approval.requested",
          threadId,
          origin: undefined,
          summary: "Command approval requested",
          detail: "rm -rf build",
        },
        "Fix billing",
      ),
    ).toBe(
      '"Fix billing" needs your approval: Command approval requested - rm -rf build. Reply /approve or /deny.',
    );
    expect(
      formatNotificationText(
        { kind: "turn.completed", threadId, origin: undefined },
        "Fix billing",
      ),
    ).toBe('Turn completed in "Fix billing".');
  });
});

describe("admitNotification", () => {
  it("admits one message per key per window and prunes stale entries", () => {
    const first = admitNotification(new Map(), "k", 1_000);
    expect(first.admit).toBe(true);
    const second = admitNotification(first.sentAt, "k", 1_000 + NOTIFY_RATE_LIMIT_MS - 1);
    expect(second.admit).toBe(false);
    const other = admitNotification(second.sentAt, "other", 2_000);
    expect(other.admit).toBe(true);
    const later = admitNotification(other.sentAt, "k", 1_000 + NOTIFY_RATE_LIMIT_MS);
    expect(later.admit).toBe(true);
    // "other" (sent at 2_000) is inside the window still; nothing older survives.
    expect([...later.sentAt.keys()].toSorted()).toEqual(["k", "other"]);
    const pruned = admitNotification(later.sentAt, "k2", 2_000 + NOTIFY_RATE_LIMIT_MS + 1);
    expect(pruned.sentAt.has("other")).toBe(false);
  });
});

describe("channel notify: thread ownership", () => {
  it("takes the thread from the bridge token when the body stays silent", () => {
    assert.deepEqual(resolveNotifyThreadId("thread-a", undefined), {
      ok: true,
      threadId: "thread-a",
    });
  });

  it("allows a body that repeats its own thread", () => {
    assert.deepEqual(resolveNotifyThreadId("thread-a", "thread-a"), {
      ok: true,
      threadId: "thread-a",
    });
  });

  it("refuses to notify on behalf of another chat", () => {
    assert.deepEqual(resolveNotifyThreadId("thread-a", "thread-b"), { ok: false });
  });
});
