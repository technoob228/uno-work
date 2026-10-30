/**
 * T3 v2 compat: reads shared by the phone socket (handlers.ts) and the v2
 * HTTP snapshots (mobileCompatRoutes.ts with `x-t3-orchestration-protocol: 2`).
 */
import type { OrchestrationThread, OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import { Effect, Option } from "effect";

import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionTurnRepositoryShape } from "../../persistence/Services/ProjectionTurns.ts";
import { toV2ShellSnapshot, type V2Json, type V2PendingRequestSummary } from "./mapShell.ts";
import {
  deriveRuntimeRequests,
  firstPendingRequest,
  toV2ThreadProjection,
  type V2TurnRow,
} from "./mapThread.ts";

export const makeV2Reads = (
  projections: ProjectionSnapshotQueryShape,
  turnRepository: ProjectionTurnRepositoryShape | undefined,
) => {
  const currentSequence = projections.getSnapshotSequence().pipe(
    Effect.map((value) => value.snapshotSequence),
    Effect.orElseSucceed(() => 0),
  );

  const readTurns = (threadId: ThreadId) =>
    turnRepository
      ? turnRepository.listByThreadId({ threadId }).pipe(
          Effect.map((rows): ReadonlyArray<V2TurnRow> => rows),
          Effect.orElseSucceed((): ReadonlyArray<V2TurnRow> => []),
        )
      : Effect.succeed<ReadonlyArray<V2TurnRow>>([]);

  const readThread = (threadId: ThreadId) =>
    projections
      .getThreadDetailById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThread>()));

  const readProjection = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const detail = yield* readThread(threadId);
      if (Option.isNone(detail)) {
        return Option.none<{ thread: OrchestrationThread; projection: V2Json }>();
      }
      const turns = yield* readTurns(threadId);
      return Option.some({
        thread: detail.value,
        projection: toV2ThreadProjection({ thread: detail.value, turns }),
      });
    });

  /** The request a waiting thread points at, for the shell badge. Only
   *  threads that wait on the person pay for a detail read. */
  const pendingSummaryOf = (thread: OrchestrationThreadShell) =>
    thread.hasPendingApprovals || thread.hasPendingUserInput
      ? readThread(thread.id).pipe(
          Effect.map(
            Option.match({
              onNone: () => null,
              onSome: (detail) => firstPendingRequest(deriveRuntimeRequests(detail.activities)),
            }),
          ),
        )
      : Effect.succeed(null);

  const buildShellSnapshot = Effect.gen(function* () {
    const snapshot = yield* projections.getShellSnapshot();
    const pendingByThreadId = new Map<string, V2PendingRequestSummary>();
    yield* Effect.forEach(
      snapshot.threads.filter((thread) => thread.hasPendingApprovals || thread.hasPendingUserInput),
      (thread) =>
        pendingSummaryOf(thread).pipe(
          Effect.tap((summary) =>
            Effect.sync(() => {
              if (summary) pendingByThreadId.set(thread.id, summary);
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
    return toV2ShellSnapshot({
      snapshotSequence: snapshot.snapshotSequence,
      projects: snapshot.projects,
      threads: snapshot.threads,
      pendingByThreadId,
    });
  });

  return {
    currentSequence,
    readThread,
    readProjection,
    pendingSummaryOf,
    buildShellSnapshot,
  };
};
