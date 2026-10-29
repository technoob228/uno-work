/**
 * ConnectorEventsForwarder - pushes system events of threads to the chats
 * bound to them (ADR 2026-09-11, "outbound channel").
 *
 * Subscribes to the orchestration domain-event stream and, per
 * `connectorNotify.ts`, tells a bound chat when a turn ends in error, when
 * a harness asks for an approval (with the `/approve` / `/deny` hint), and —
 * only for bindings that opted in — when a turn completes. Rate-limited per
 * (chat, thread, kind); a chat is not told about the end of its own turns
 * (the reply watcher already answers there).
 *
 * Only explicit thread / project bindings receive pushes: there is no
 * assistant fallback here, or every error anywhere would land in the
 * owner's chat.
 */
import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Option, Ref, Stream } from "effect";

import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import type { ResolvedNotifyChat } from "../connectorBindings.ts";
import {
  APPROVAL_BUTTONS_TTL_MS,
  approvalButtons,
  approvalMessageText,
} from "../connectorButtons.ts";
import { detectReplyLanguage } from "../connectorReplyText.ts";
import { ManagerTelegramService } from "./TelegramConnector.ts";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorPendingReplyRepositoryLive } from "../../persistence/Layers/ManagerConnectorPendingReplies.ts";
import { ManagerConnectorPendingReplyRepository } from "../../persistence/Services/ManagerConnectorPendingReplies.ts";
import {
  admitNotification,
  APPROVAL_FALLBACK_DELAY_MS,
  formatNotificationText,
  pickPersonChats,
  resolvedApprovalRequestId,
  INITIAL_NOTIFY_TRACKER_STATE,
  notifyChatKey,
  notifyRateLimitKey,
  selectNotificationChats,
  trackDomainEvent,
  type ConnectorNotification,
  type NotifyTrackerState,
} from "../connectorNotify.ts";
import { AssistantPushService } from "../Services/AssistantPush.ts";
import { ConnectorNotifyService } from "../Services/ConnectorNotify.ts";

const makeConnectorEventsForwarder = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const notifyService = yield* ConnectorNotifyService;
  const pendingReplies = yield* ManagerConnectorPendingReplyRepository;
  // Optional: wirings without it (tests) keep every notice.
  const push = Option.getOrNull(yield* Effect.serviceOption(AssistantPushService));

  const telegram = yield* ManagerTelegramService;
  const pendingApprovals = yield* ProjectionPendingApprovalRepository;

  const trackerRef = yield* Ref.make<NotifyTrackerState>(INITIAL_NOTIFY_TRACKER_STATE);

  const isStillPending = (threadId: ThreadId, requestId: string) =>
    pendingApprovals.listByThreadId({ threadId }).pipe(
      Effect.map((rows) =>
        rows.some((row) => row.status === "pending" && row.requestId === requestId),
      ),
      Effect.orElseSucceed(() => false),
    );

  /**
   * An approval request as ONE Telegram message with Allow / Deny (the
   * press resolves it, TelegramConnector.ts); Slack keeps the /approve text.
   */
  const sendApproval = (
    chats: ReadonlyArray<ResolvedNotifyChat>,
    notification: Extract<ConnectorNotification, { kind: "approval.requested" }>,
    threadTitle: string,
  ) =>
    Effect.gen(function* () {
      const requestId = notification.requestId;
      const language = detectReplyLanguage(`${threadTitle}\n${notification.detail ?? ""}`, null);
      const text = approvalMessageText({
        threadTitle,
        requestKind: notification.requestKind,
        detail: notification.detail,
        language,
      });
      const plain = chats.filter((chat) => chat.kind !== "telegram" || requestId === null);
      let delivered = 0;
      for (const chat of chats) {
        if (chat.kind !== "telegram" || requestId === null) continue;
        const sent = yield* telegram.sendRich({
          projectId: chat.connectorProjectId,
          chatId: chat.chatId,
          text,
          buttons: approvalButtons(requestId, language),
          buttonsTtlMs: APPROVAL_BUTTONS_TTL_MS,
          threadId: notification.threadId,
          // A bound chat talks to this thread already; the person's own
          // chat answers it with a reply to this message.
          routeReplies: chat.via === "assistant",
          language,
        });
        if (sent.ok) delivered += 1;
      }
      if (plain.length > 0) {
        const result = yield* notifyService.sendToChats(
          plain,
          formatNotificationText(notification, threadTitle),
        );
        delivered += result.delivered;
      }
      return delivered;
    });

  /**
   * Nobody bound a chat to this thread: after a pause, if the request still
   * waits, it goes to the person's own private Telegram chat (their bot or
   * Uno's) — never to a group.
   */
  const sendApprovalToPersonLater = (
    notification: Extract<ConnectorNotification, { kind: "approval.requested" }>,
    projectId: Parameters<typeof notifyService.resolveChats>[0]["projectId"],
    threadTitle: string,
  ) =>
    Effect.gen(function* () {
      const requestId = notification.requestId;
      if (requestId === null) return;
      yield* Effect.sleep(APPROVAL_FALLBACK_DELAY_MS);
      if (!(yield* isStillPending(notification.threadId, requestId))) return;
      const chats = pickPersonChats(
        yield* notifyService.resolveChats({
          threadId: notification.threadId,
          projectId,
          includeAssistantFallback: true,
        }),
      ).filter((chat) => chat.kind === "telegram" && chat.via === "assistant");
      if (chats.length === 0) return;
      const delivered = yield* sendApproval(chats, notification, threadTitle);
      yield* Effect.logInfo("approval request sent to the person's Telegram").pipe(
        Effect.annotateLogs({ threadId: notification.threadId, delivered }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("approval request to the person failed").pipe(
          Effect.annotateLogs({ threadId: notification.threadId, cause }),
        ),
      ),
      Effect.forkDetach,
    );
  const sentAtRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const handleEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      // Answered anywhere (the app, /approve, a button): its buttons go.
      const resolvedRequestId = resolvedApprovalRequestId(event);
      if (resolvedRequestId !== null) {
        yield* telegram.retireRequestButtons(resolvedRequestId);
        return;
      }
      const notification = yield* Ref.modify(trackerRef, (state) => {
        const next = trackDomainEvent(state, event);
        return [next.notification, next.state] as const;
      });
      if (notification === null) {
        return;
      }
      // A chat an assistant handed work to: the assistant checks the result
      // and reports it to the person itself (assistantPush.ts). Its raw
      // "completed" / "failed" would double that; an approval request still
      // goes out here (it is actionable with /approve right in that chat).
      if (
        notification.kind !== "approval.requested" &&
        push !== null &&
        (yield* push.reportsOutcomeOf(notification.threadId))
      ) {
        return;
      }
      const shell = yield* projectionSnapshotQuery
        .getThreadShellById(notification.threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const chats = yield* notifyService.resolveChats({
        threadId: notification.threadId,
        projectId: Option.isSome(shell) ? shell.value.projectId : null,
        includeAssistantFallback: false,
      });
      // Chats still owed their own answer in this thread hear it from the
      // reply watcher, not from here (see `selectNotificationChats`).
      const awaitingReply = new Set(
        (yield* pendingReplies
          .listByThread({ threadId: notification.threadId, limit: 50 })
          .pipe(Effect.orElseSucceed(() => [])))
          .filter((row) => row.status === "queued" || row.status === "waiting")
          .map(notifyChatKey),
      );
      const selected = selectNotificationChats(chats, notification, awaitingReply);
      const threadTitle = Option.isSome(shell) ? shell.value.title : notification.threadId;
      if (selected.length === 0) {
        if (notification.kind === "approval.requested" && chats.length === 0) {
          yield* sendApprovalToPersonLater(
            notification,
            Option.isSome(shell) ? shell.value.projectId : null,
            threadTitle,
          );
        }
        return;
      }
      const nowMs = Date.now();
      const admitted = yield* Ref.modify(sentAtRef, (sentAt) => {
        let ledger = sentAt;
        const passed = selected.filter((chat) => {
          const verdict = admitNotification(
            ledger,
            notifyRateLimitKey(
              chat,
              notification.threadId,
              notification.kind,
              notification.kind === "approval.requested" ? notification.requestId : null,
            ),
            nowMs,
          );
          ledger = verdict.sentAt;
          return verdict.admit;
        });
        return [passed, ledger] as const;
      });
      if (admitted.length === 0) {
        return;
      }
      const delivered =
        notification.kind === "approval.requested"
          ? yield* sendApproval(admitted, notification, threadTitle)
          : (yield* notifyService.sendToChats(
              admitted,
              formatNotificationText(notification, threadTitle),
            )).delivered;
      yield* Effect.logInfo("connector notification forwarded").pipe(
        Effect.annotateLogs({
          threadId: notification.threadId,
          kind: notification.kind,
          delivered,
          chats: admitted.length,
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("connector events forwarder failed on an event").pipe(
          Effect.annotateLogs({ eventType: event.type, cause }),
        ),
      ),
    );

  yield* Effect.forkScoped(
    orchestrationEngine.streamDomainEvents.pipe(Stream.runForEach(handleEvent)),
  );
});

export const ConnectorEventsForwarderLive = Layer.effectDiscard(makeConnectorEventsForwarder).pipe(
  Layer.provide(ManagerConnectorPendingReplyRepositoryLive),
);
