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
import type { OrchestrationEvent } from "@t3tools/contracts";
import { Effect, Layer, Option, Ref, Stream } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorPendingReplyRepositoryLive } from "../../persistence/Layers/ManagerConnectorPendingReplies.ts";
import { ManagerConnectorPendingReplyRepository } from "../../persistence/Services/ManagerConnectorPendingReplies.ts";
import {
  admitNotification,
  formatNotificationText,
  INITIAL_NOTIFY_TRACKER_STATE,
  notifyChatKey,
  notifyRateLimitKey,
  selectNotificationChats,
  trackDomainEvent,
  type NotifyTrackerState,
} from "../connectorNotify.ts";
import { ConnectorNotifyService } from "../Services/ConnectorNotify.ts";

const makeConnectorEventsForwarder = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const notifyService = yield* ConnectorNotifyService;
  const pendingReplies = yield* ManagerConnectorPendingReplyRepository;

  const trackerRef = yield* Ref.make<NotifyTrackerState>(INITIAL_NOTIFY_TRACKER_STATE);
  const sentAtRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

  const handleEvent = (event: OrchestrationEvent) =>
    Effect.gen(function* () {
      const notification = yield* Ref.modify(trackerRef, (state) => {
        const next = trackDomainEvent(state, event);
        return [next.notification, next.state] as const;
      });
      if (notification === null) {
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
      if (selected.length === 0) {
        return;
      }
      const nowMs = Date.now();
      const admitted = yield* Ref.modify(sentAtRef, (sentAt) => {
        let ledger = sentAt;
        const passed = selected.filter((chat) => {
          const verdict = admitNotification(
            ledger,
            notifyRateLimitKey(chat, notification.threadId, notification.kind),
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
      const threadTitle = Option.isSome(shell) ? shell.value.title : notification.threadId;
      const result = yield* notifyService.sendToChats(
        admitted,
        formatNotificationText(notification, threadTitle),
      );
      yield* Effect.logInfo("connector notification forwarded").pipe(
        Effect.annotateLogs({
          threadId: notification.threadId,
          kind: notification.kind,
          delivered: result.delivered,
          chats: result.chats.length,
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
