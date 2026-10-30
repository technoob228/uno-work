import { CommandId, MessageId, type ThreadId } from "@t3tools/contracts";
import { isPlanLimitText } from "@t3tools/shared/planLimitRules";
import { UNO_WORK_NOTE_PREFIX } from "@t3tools/shared/secretRequestCopy";
import {
  decideTurnAutoRetry,
  turnAutoRetryNoteBody,
  type TurnAutoRetryDecision,
} from "@t3tools/shared/turnErrorRetry";
import { Cause, Effect, Fiber, Layer, Option, Scope, Stream } from "effect";

import { isUnoBillingErrorDetail } from "../../provider/unoBilling.ts";
import { systemCommandOrigin } from "../commandOrigin.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  TURN_AUTO_RETRY_COMMAND_PREFIX,
  TURN_AUTO_RETRY_ORIGIN_COMPONENT,
  TurnAutoRetry,
  type TurnAutoRetryShape,
} from "../Services/TurnAutoRetry.ts";

type ScheduledRetry = Extract<TurnAutoRetryDecision, { retry: true }>;

interface ChainState {
  /** Automatic continuations already made in this chain of turns. */
  attemptsUsed: number;
  /** The continuation waiting to be sent, with the error it answers. */
  pending: {
    readonly decision: ScheduledRetry;
    readonly error: string;
    fiber: Fiber.Fiber<void> | undefined;
  } | null;
}

/**
 * Domain events after which a waiting continuation must not be sent. Every
 * turn start counts except our own: the person's message (or a connector's,
 * an agent's, a schedule's) is a new chain.
 */
const CANCELLING_EVENT_TYPES = new Set([
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.session-stop-requested",
  "thread.reverted",
  "thread.archived",
  "thread.deleted",
]);

export interface TurnAutoRetryLayerOptions {
  /** Tests only: how long to actually wait for a decision. */
  readonly delayMs?: (decision: ScheduledRetry) => number;
}

/**
 * One in-memory chain per thread: the daemon process is the only writer, and
 * a restart during the wait is handled by startup reconciliation (the thread,
 * still "running" with no turn, becomes "did not survive a restart") — the
 * continuation is lost then, which is the honest outcome.
 *
 * Applies to every harness, not only the ones on the Uno AI gateway
 * (OpenCode / Uno / Hermes): the patterns are the gateway's own sentences
 * plus providers' generic 429 / overloaded / 50x, and two continuations of
 * those cost little on any provider.
 */
export const makeTurnAutoRetryLayer = (options: TurnAutoRetryLayerOptions = {}) =>
  Layer.effect(
    TurnAutoRetry,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const projections = yield* ProjectionSnapshotQuery;
      const layerScope = yield* Scope.Scope;
      const chains = new Map<string, ChainState>();
      const delayOf = options.delayMs ?? ((decision: ScheduledRetry) => decision.delayMs);

      const cancel = (threadId: string, why: string) =>
        Effect.suspend(() => {
          const chain = chains.get(threadId);
          chains.delete(threadId);
          const fiber = chain?.pending?.fiber;
          if (!fiber) return Effect.void;
          return Effect.logInfo("turn auto-retry: called off").pipe(
            Effect.annotateLogs({ threadId, why }),
            Effect.andThen(Fiber.interrupt(fiber)),
            Effect.asVoid,
          );
        });

      /** Show the error after all: the continuation could not be sent. */
      const giveUp = (threadId: ThreadId, error: string, detail: string) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("turn auto-retry: could not continue the turn").pipe(
            Effect.annotateLogs({ threadId, detail }),
          );
          const shell = yield* projections
            .getThreadShellById(threadId)
            .pipe(Effect.map(Option.getOrNull));
          const session = shell?.session;
          if (!session || session.status !== "running" || session.activeTurnId !== null) return;
          const now = new Date().toISOString();
          yield* engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(
              `${TURN_AUTO_RETRY_COMMAND_PREFIX}give-up:${crypto.randomUUID()}`,
            ),
            threadId,
            session: {
              ...session,
              status: "error",
              lastError: error,
              lastErrorClass: "provider_error",
              updatedAt: now,
            },
            createdAt: now,
          });
        });

      const send = (threadId: ThreadId, decision: ScheduledRetry, error: string) =>
        Effect.gen(function* () {
          const chain = chains.get(threadId);
          if (chain?.pending?.decision !== decision) return;
          chain.pending = null;
          const shell = yield* projections
            .getThreadShellById(threadId)
            .pipe(Effect.map(Option.getOrNull));
          const session = shell?.session;
          // Only the state this service left behind ("running", no turn) is
          // ours to continue; anything else means someone else acted.
          if (
            !shell ||
            shell.archivedAt !== null ||
            !session ||
            session.status !== "running" ||
            session.activeTurnId !== null
          ) {
            chains.delete(threadId);
            return;
          }
          const createdAt = new Date().toISOString();
          yield* engine.dispatch(
            {
              type: "thread.turn.start",
              commandId: CommandId.make(`${TURN_AUTO_RETRY_COMMAND_PREFIX}${crypto.randomUUID()}`),
              threadId,
              message: {
                messageId: MessageId.make(crypto.randomUUID()),
                role: "user",
                text: `${UNO_WORK_NOTE_PREFIX}${turnAutoRetryNoteBody(decision)}`,
                attachments: [],
              },
              runtimeMode: shell.runtimeMode,
              interactionMode: shell.interactionMode,
              createdAt,
            },
            {
              origin: systemCommandOrigin(
                TURN_AUTO_RETRY_ORIGIN_COMPONENT,
                `${decision.kind} ${decision.attempt} of ${decision.maxAttempts}`,
              ),
            },
          );
          yield* Effect.logInfo("turn auto-retry: continued the turn").pipe(
            Effect.annotateLogs({
              threadId,
              kind: decision.kind,
              attempt: decision.attempt,
            }),
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : giveUp(threadId, error, Cause.pretty(cause)),
          ),
          Effect.ignoreCause({ log: true }),
        );

      const onTurnFailed: TurnAutoRetryShape["onTurnFailed"] = ({ threadId, error }) =>
        Effect.gen(function* () {
          const chain = chains.get(threadId) ?? { attemptsUsed: 0, pending: null };
          if (chain.pending !== null) return chain.pending.decision;
          // Billing words never read as busy / didn't answer, but a top-up
          // page in the same message must win over a stray "429".
          // Nor does retrying help a plan at its limit: planResume/ waits for the reset.
          const decision: TurnAutoRetryDecision =
            isUnoBillingErrorDetail(error) || isPlanLimitText(error)
              ? { retry: false, reason: "not-retryable" }
              : decideTurnAutoRetry({ error, attemptsUsed: chain.attemptsUsed });
          if (!decision.retry) {
            chains.delete(threadId);
            if (decision.reason === "attempts-used") {
              yield* Effect.logInfo("turn auto-retry: attempts used, the person decides").pipe(
                Effect.annotateLogs({ threadId }),
              );
            }
            return decision;
          }
          const pending: NonNullable<ChainState["pending"]> = {
            decision,
            error,
            fiber: undefined,
          };
          chain.attemptsUsed = decision.attempt;
          chain.pending = pending;
          chains.set(threadId, chain);
          pending.fiber = yield* Effect.sleep(delayOf(decision)).pipe(
            Effect.andThen(send(threadId, decision, error)),
            Effect.forkIn(layerScope),
          );
          yield* Effect.logInfo("turn auto-retry: scheduled").pipe(
            Effect.annotateLogs({
              threadId,
              kind: decision.kind,
              attempt: decision.attempt,
              delayMs: decision.delayMs,
            }),
          );
          return decision;
        });

      const onTurnSucceeded: TurnAutoRetryShape["onTurnSucceeded"] = (threadId) =>
        Effect.sync(() => {
          const chain = chains.get(threadId);
          if (chain && chain.pending === null) chains.delete(threadId);
        });

      const isPending: TurnAutoRetryShape["isPending"] = (threadId) =>
        Effect.sync(() => (chains.get(threadId)?.pending ?? null) !== null);

      const start: TurnAutoRetryShape["start"] = () =>
        Effect.forkScoped(
          Stream.runForEach(engine.streamDomainEvents, (event) => {
            if (!CANCELLING_EVENT_TYPES.has(event.type)) return Effect.void;
            if (event.commandId?.startsWith(TURN_AUTO_RETRY_COMMAND_PREFIX)) return Effect.void;
            const threadId = String(event.aggregateId);
            if (!chains.has(threadId)) return Effect.void;
            return cancel(threadId, event.type);
          }),
        ).pipe(Effect.asVoid);

      return { onTurnFailed, onTurnSucceeded, isPending, start } satisfies TurnAutoRetryShape;
    }),
  );

export const TurnAutoRetryLive = makeTurnAutoRetryLayer();
