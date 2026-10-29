/**
 * Outbound notifications to bound chats — the pure half.
 *
 * {@link trackDomainEvent} folds the orchestration event stream into the
 * three things a chat is told about: a turn that ended in error, an approval
 * request, and (opt-in per binding) a completed turn. It remembers per
 * thread who started the last turn (`metadata.origin`) and the last session
 * status, so a "ready" after "running" reads as "turn completed" and the
 * chat that sent the message is not told twice about its own turn (it gets
 * the reply through the connector's reply watcher).
 *
 * {@link admitNotification} is the rate limiter: at most one message per
 * (chat, thread, kind) per {@link NOTIFY_RATE_LIMIT_MS}.
 */
import type {
  ChannelNotifyKind,
  OrchestrationCommandOrigin,
  OrchestrationEvent,
  OrchestrationSessionErrorClass,
  OrchestrationSessionStatus,
  ThreadId,
} from "@t3tools/contracts";

import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";

import { isPrivateTelegramChatId, type ResolvedNotifyChat } from "./connectorBindings.ts";

export type ConnectorNotificationKind = "turn.error" | "approval.requested" | "turn.completed";

export type ConnectorNotification =
  | {
      readonly kind: "turn.error";
      readonly threadId: ThreadId;
      readonly origin: OrchestrationCommandOrigin | undefined;
      readonly errorClass: OrchestrationSessionErrorClass | null;
      readonly errorText: string | null;
    }
  | {
      readonly kind: "approval.requested";
      readonly threadId: ThreadId;
      readonly origin: OrchestrationCommandOrigin | undefined;
      readonly summary: string;
      readonly detail: string | null;
      /** The request to answer (Allow / Deny buttons); null on an older payload. */
      readonly requestId: string | null;
      readonly requestKind: "command" | "file-read" | "file-change" | null;
    }
  | {
      readonly kind: "turn.completed";
      readonly threadId: ThreadId;
      readonly origin: OrchestrationCommandOrigin | undefined;
    };

export interface NotifyTrackerState {
  /** Origin of the latest turn per thread; `undefined` = a human in the app. */
  readonly turnOrigins: ReadonlyMap<ThreadId, OrchestrationCommandOrigin | undefined>;
  readonly sessionStatus: ReadonlyMap<ThreadId, OrchestrationSessionStatus>;
}

export const INITIAL_NOTIFY_TRACKER_STATE: NotifyTrackerState = {
  turnOrigins: new Map(),
  sessionStatus: new Map(),
};

const withoutThread = (state: NotifyTrackerState, threadId: ThreadId): NotifyTrackerState => {
  const turnOrigins = new Map(state.turnOrigins);
  const sessionStatus = new Map(state.sessionStatus);
  turnOrigins.delete(threadId);
  sessionStatus.delete(threadId);
  return { turnOrigins, sessionStatus };
};

const APPROVAL_DETAIL_MAX_CHARS = 400;

export const trackDomainEvent = (
  state: NotifyTrackerState,
  event: OrchestrationEvent,
): { readonly state: NotifyTrackerState; readonly notification: ConnectorNotification | null } => {
  switch (event.type) {
    case "thread.turn-start-requested": {
      const turnOrigins = new Map(state.turnOrigins);
      turnOrigins.set(event.payload.threadId, event.metadata.origin);
      return { state: { ...state, turnOrigins }, notification: null };
    }
    case "thread.session-set": {
      const { threadId, session } = event.payload;
      const previous = state.sessionStatus.get(threadId);
      const sessionStatus = new Map(state.sessionStatus);
      sessionStatus.set(threadId, session.status);
      const next = { ...state, sessionStatus };
      const origin = state.turnOrigins.get(threadId);
      if (session.status === "error" && previous !== "error") {
        return {
          state: next,
          notification: {
            kind: "turn.error",
            threadId,
            origin,
            errorClass: session.lastErrorClass ?? null,
            errorText: session.lastError,
          },
        };
      }
      if (previous === "running" && session.status === "ready" && session.activeTurnId === null) {
        return { state: next, notification: { kind: "turn.completed", threadId, origin } };
      }
      return { state: next, notification: null };
    }
    case "thread.activity-appended": {
      const { threadId, activity } = event.payload;
      if (activity.kind !== "approval.requested") {
        return { state, notification: null };
      }
      const payload =
        typeof activity.payload === "object" && activity.payload !== null
          ? (activity.payload as {
              readonly detail?: unknown;
              readonly requestId?: unknown;
              readonly requestKind?: unknown;
            })
          : {};
      const detail =
        typeof payload.detail === "string" && payload.detail.trim().length > 0
          ? payload.detail.trim().slice(0, APPROVAL_DETAIL_MAX_CHARS)
          : null;
      return {
        state,
        notification: {
          kind: "approval.requested",
          threadId,
          origin: state.turnOrigins.get(threadId),
          summary: activity.summary,
          detail,
          requestId:
            typeof payload.requestId === "string" && payload.requestId.length > 0
              ? payload.requestId
              : null,
          requestKind:
            payload.requestKind === "command" ||
            payload.requestKind === "file-read" ||
            payload.requestKind === "file-change"
              ? payload.requestKind
              : null,
        },
      };
    }
    case "thread.deleted":
    case "thread.archived":
      return { state: withoutThread(state, event.payload.threadId), notification: null };
    default:
      return { state, notification: null };
  }
};

/** Did this turn come from that very chat (which already gets the reply)? */
export const isOwnOriginChat = (
  origin: OrchestrationCommandOrigin | undefined,
  chat: { readonly kind: "telegram" | "slack"; readonly chatId: string },
): boolean =>
  origin !== undefined &&
  origin.kind === "connector" &&
  origin.connector === chat.kind &&
  origin.externalActorId === chat.chatId;

/**
 * Kinds a chat is not told about for its own turns. Approval requests are
 * deliberately NOT here: the reply watcher only reports the end of a turn,
 * so a turn blocked on an approval would otherwise sit silent until it
 * times out — and `/approve` exists precisely for this moment.
 */
export const SUPPRESS_OWN_ORIGIN_KINDS: ReadonlySet<ConnectorNotificationKind> = new Set([
  "turn.error",
  "turn.completed",
]);

/** Key of a chat in {@link selectNotificationChats}' `awaitingReply`. */
export const notifyChatKey = (chat: { readonly kind: string; readonly chatId: string }) =>
  `${chat.kind}:${chat.chatId}`;

/**
 * Which of the resolved chats should hear this notification. `awaitingReply`
 * holds the chats ({@link notifyChatKey}) that wait for their own answer in
 * this thread (`manager_connector_pending_replies`): the reply watcher tells
 * them how the turn ended — and re-runs a turn a restart cut off, so a
 * "Send a new message to continue" would be wrong. Unlike the in-memory
 * origin, it survives a daemon restart.
 */
export const selectNotificationChats = (
  chats: ReadonlyArray<ResolvedNotifyChat>,
  notification: ConnectorNotification,
  awaitingReply: ReadonlySet<string> = new Set(),
): ReadonlyArray<ResolvedNotifyChat> =>
  chats.filter((chat) => {
    if (notification.kind === "turn.completed" && !chat.notifyOnComplete) {
      return false;
    }
    if (
      SUPPRESS_OWN_ORIGIN_KINDS.has(notification.kind) &&
      (isOwnOriginChat(notification.origin, chat) || awaitingReply.has(notifyChatKey(chat)))
    ) {
      return false;
    }
    return true;
  });

export const formatNotificationText = (
  notification: ConnectorNotification,
  threadTitle: string,
): string => {
  const title = `"${threadTitle}"`;
  switch (notification.kind) {
    case "turn.error": {
      // Out of AI credit / hours: the error text is already the person's way
      // out (provider/unoBilling.ts); an internal class tag does not go out.
      if (notification.errorClass === "billing_error" && notification.errorText !== null) {
        return `AI stopped in ${title}: ${notification.errorText}`;
      }
      const parts = [`Turn failed in ${title}`];
      if (notification.errorClass !== null) {
        parts.push(`[${notification.errorClass}]`);
      }
      const head = parts.join(" ");
      return notification.errorText === null ? `${head}.` : `${head}: ${notification.errorText}`;
    }
    case "approval.requested": {
      const what =
        notification.detail === null
          ? notification.summary
          : `${notification.summary} - ${notification.detail}`;
      return `${title} needs your approval: ${what}. Reply /approve or /deny.`;
    }
    case "turn.completed":
      return `Turn completed in ${title}.`;
  }
};

/** Prefix for software-originated messages (`POST /api/channels/notify`). */
export const formatChannelNotifyText = (
  text: string,
  kind: ChannelNotifyKind | undefined,
): string => (kind === "error" ? `Error: ${text}` : kind === "warning" ? `Warning: ${text}` : text);

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export const NOTIFY_RATE_LIMIT_MS = 30_000;

export const notifyRateLimitKey = (
  chat: { readonly kind: string; readonly chatId: string },
  threadId: ThreadId,
  kind: ConnectorNotificationKind,
  /** An approval request: each one is its own message (its own buttons). */
  requestId: string | null = null,
): string =>
  `${chat.kind}:${chat.chatId}|${threadId}|${kind}${requestId === null ? "" : `|${requestId}`}`;

/** The request an approval-resolved event closes (its Telegram buttons go), or null. */
export const resolvedApprovalRequestId = (event: OrchestrationEvent): string | null => {
  if (event.type === "thread.approval-response-requested") return event.payload.requestId;
  if (
    event.type === "thread.activity-appended" &&
    event.payload.activity.kind === "approval.resolved"
  ) {
    const payload = event.payload.activity.payload as { readonly requestId?: unknown } | null;
    return typeof payload?.requestId === "string" ? payload.requestId : null;
  }
  return null;
};

/**
 * How long an approval waits before it goes to the person's own Telegram
 * (no chat bound to the thread): someone at the screen answers it in the
 * app first, and nobody's phone buzzes for it.
 */
export const APPROVAL_FALLBACK_DELAY_MS = 30_000;

/**
 * Admit at most one message per key per window. Returns the updated ledger
 * with entries older than the window dropped, so it stays bounded.
 */
export const admitNotification = (
  sentAt: ReadonlyMap<string, number>,
  key: string,
  nowMs: number,
): { readonly admit: boolean; readonly sentAt: ReadonlyMap<string, number> } => {
  const last = sentAt.get(key);
  const next = new Map<string, number>();
  for (const [entryKey, entryAt] of sentAt) {
    if (nowMs - entryAt < NOTIFY_RATE_LIMIT_MS) {
      next.set(entryKey, entryAt);
    }
  }
  if (last !== undefined && nowMs - last < NOTIFY_RATE_LIMIT_MS) {
    return { admit: false, sentAt: next };
  }
  next.set(key, nowMs);
  return { admit: true, sentAt: next };
};

/**
 * Какому треду принадлежит `POST /api/channels/notify`.
 *
 * Тред называет bridge-токен сессии. Явный `threadId` в теле разрешён только
 * как повтор своего же треда: раньше, с общим токеном машины, им можно было
 * отправить уведомление от имени чужого чата.
 */
export const resolveNotifyThreadId = (
  tokenThreadId: string,
  requestedThreadId: string | undefined,
): { readonly ok: true; readonly threadId: string } | { readonly ok: false } =>
  requestedThreadId === undefined || requestedThreadId === tokenThreadId
    ? { ok: true, threadId: tokenThreadId }
    : { ok: false };

// ---------------------------------------------------------------------------
// A chat writes to the person (`messenger_send`)
// ---------------------------------------------------------------------------

/**
 * Which of the resolved chats a chat's own message goes to: the chats bound
 * to it (or its project) when there are any — the person set that up;
 * otherwise the person's own private chat, ONE per channel person: Telegram
 * when linked (their bot or Uno's; the default assistant's link first when
 * several bots know the same person), else the Slack DM. Never a group or a
 * channel by fallback: a work chat must not speak to other people.
 */
export const pickPersonChats = (
  chats: ReadonlyArray<ResolvedNotifyChat>,
): ReadonlyArray<ResolvedNotifyChat> => {
  const bound = chats.filter((chat) => chat.via !== "assistant");
  if (bound.length > 0) return bound;
  const own = chats
    .filter(
      (chat) =>
        chat.via === "assistant" && (chat.kind === "slack" || isPrivateTelegramChatId(chat.chatId)),
    )
    .toSorted(
      (a, b) =>
        Number(b.connectorProjectId === ASSISTANT_PROJECT_ID) -
        Number(a.connectorProjectId === ASSISTANT_PROJECT_ID),
    );
  const firstPerChat = (kind: ResolvedNotifyChat["kind"]) => {
    const seen = new Set<string>();
    return own.filter((chat) => {
      if (chat.kind !== kind || seen.has(chat.chatId)) return false;
      seen.add(chat.chatId);
      return true;
    });
  };
  const telegram = firstPerChat("telegram");
  return telegram.length > 0 ? telegram : firstPerChat("slack");
};

/** Messages one chat may send the person in {@link PERSON_MESSAGE_WINDOW_MS}. */
export const PERSON_MESSAGE_LIMIT = 8;
export const PERSON_MESSAGE_WINDOW_MS = 10 * 60_000;

/** Admit one more message of this chat, or not (the ledger keeps the window only). */
export const admitPersonMessage = (
  sentAt: ReadonlyMap<string, ReadonlyArray<number>>,
  threadId: string,
  nowMs: number,
): { readonly admit: boolean; readonly sentAt: ReadonlyMap<string, ReadonlyArray<number>> } => {
  const next = new Map<string, ReadonlyArray<number>>();
  for (const [key, times] of sentAt) {
    const recent = times.filter((at) => nowMs - at < PERSON_MESSAGE_WINDOW_MS);
    if (recent.length > 0) next.set(key, recent);
  }
  const recent = next.get(threadId) ?? [];
  if (recent.length >= PERSON_MESSAGE_LIMIT) return { admit: false, sentAt: next };
  next.set(threadId, [...recent, nowMs]);
  return { admit: true, sentAt: next };
};
