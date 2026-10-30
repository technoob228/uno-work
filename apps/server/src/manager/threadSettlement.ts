/**
 * Has a thread's current turn settled — the effectful half of
 * `threadWait.ts`, shared by `wait_for_thread(s)` (ManagerToolService) and
 * the assistant's completion push (`Layers/AssistantPush.ts`), so "done",
 * "failed" and "needs the person" mean the same thing in both.
 *
 * @module manager/threadSettlement
 */
import type { ManagerPendingApprovalSummary, ThreadId } from "@t3tools/contracts";
import { Clock, Effect, Option } from "effect";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionPendingApprovalRepository } from "../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import {
  describePendingRequest,
  evaluateThreadWait,
  findTurnReply,
  shouldHoldForReply,
  type ThreadWaitVerdict,
  type WaitMessage,
} from "./threadWait.ts";

export type SettledProbe = {
  readonly verdict: Extract<ThreadWaitVerdict, { settled: true }>;
  readonly reply: WaitMessage | null;
  readonly pendingRequest: string | null;
  readonly pendingApprovals: ReadonlyArray<ManagerPendingApprovalSummary>;
};

/** The newest `provider.turn.start.failed` of a thread: why its turn never started. */
export const latestStartFailure = (
  activities: ReadonlyArray<{
    readonly kind: string;
    readonly createdAt: string;
    readonly payload: unknown;
  }>,
): { readonly detail: string; readonly at: string } | null => {
  const failure = activities.findLast((activity) => activity.kind === "provider.turn.start.failed");
  if (failure === undefined) return null;
  const detail = (failure.payload as { readonly detail?: unknown } | null)?.detail;
  return {
    detail:
      typeof detail === "string" && detail.trim().length > 0
        ? detail.trim()
        : "The chat could not start.",
    at: failure.createdAt,
  };
};

/** `probe(threadId)`: one look at a thread — `null` while its turn is still in flight. */
export const makeThreadSettlementProbe = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const pendingApprovalRepository = yield* ProjectionPendingApprovalRepository;

  const listPendingApprovalsOf = (threadId: ThreadId) =>
    pendingApprovalRepository.listByThreadId({ threadId }).pipe(
      Effect.map((rows) =>
        rows
          .filter((row) => row.status === "pending")
          .map(
            (row): ManagerPendingApprovalSummary => ({
              threadId: row.threadId,
              requestId: row.requestId,
              createdAt: row.createdAt,
            }),
          ),
      ),
    );

  const probe = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* projectionSnapshotQuery.getThreadShellById(threadId);
      if (Option.isNone(shell)) {
        return {
          verdict: {
            settled: true,
            status: "error",
            turn: null,
            error: "The thread no longer exists.",
          },
          reply: null,
          pendingRequest: null,
          pendingApprovals: [],
        } satisfies SettledProbe as SettledProbe;
      }
      const turns = yield* projectionTurnRepository.listByThreadId({ threadId });
      const nowMs = yield* Clock.currentTimeMillis;
      const session = shell.value.session;
      // A turn that never got an id: did the harness refuse to start it?
      const startFailure = turns.some((turn) => turn.state === "pending" && turn.turnId === null)
        ? yield* projectionSnapshotQuery
            .getThreadDetailById(threadId)
            .pipe(
              Effect.map((detail) =>
                Option.isSome(detail) ? latestStartFailure(detail.value.activities) : null,
              ),
            )
        : null;
      const verdict = evaluateThreadWait({
        startFailure,
        hasPendingApprovals: shell.value.hasPendingApprovals,
        hasPendingUserInput: shell.value.hasPendingUserInput,
        session:
          session === null
            ? null
            : {
                status: session.status,
                updatedAt: session.updatedAt,
                lastError: session.lastError,
              },
        turns,
        nowMs,
      });
      if (!verdict.settled) {
        return null;
      }
      const detail = yield* projectionSnapshotQuery.getThreadDetailById(threadId);
      const reply = Option.isSome(detail)
        ? findTurnReply(verdict.turn, detail.value.messages)
        : null;
      if (shouldHoldForReply(verdict, reply, nowMs)) {
        return null;
      }
      const needsUser = verdict.status === "needs_user";
      return {
        verdict,
        reply,
        pendingRequest:
          needsUser && Option.isSome(detail)
            ? describePendingRequest(detail.value.activities)
            : null,
        pendingApprovals: needsUser ? yield* listPendingApprovalsOf(threadId) : [],
      } satisfies SettledProbe as SettledProbe;
    });

  return { probe, listPendingApprovalsOf };
});
