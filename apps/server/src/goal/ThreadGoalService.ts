/**
 * ThreadGoalService — `/goal`: after each turn, checks the goal and starts the
 * next turn, until the agent says it is done or a ceiling stops it.
 *
 * The `thread_goals` row is the source of truth, so ceilings survive a
 * restart. Clients follow a goal through `goal.updated` activities. Turns go
 * through the same `thread.turn.start` as any other, with the chat's own modes:
 * a goal never raises access, and a turn waiting for approval just waits.
 * Text from outside (a webhook, a form) never drives a goal: a chat holding it
 * refuses one, and a goal running when it arrives stops.
 *
 * @module goal/ThreadGoalService
 */
import {
  CommandId,
  EventId,
  MessageId,
  THREAD_GOAL_ACTIVITY_KIND,
  type OrchestrationEvent,
  type OrchestrationStopThreadGoalResult,
  type ProviderRuntimeEvent,
  type ThreadGoalState,
  type ThreadGoalStatus,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { UNO_WORK_NOTE_PREFIX } from "@t3tools/shared/secretRequestCopy";
import {
  addReportedCost,
  decideGoalStep,
  GOAL_COMMAND_PREFIX,
  GOAL_MAX_COST_USD,
  GOAL_MAX_MINUTES,
  GOAL_MAX_TURNS,
  GOAL_ORIGIN_COMPONENT,
  goalNoteBody,
  readGoalVerdict,
} from "@t3tools/shared/threadGoal";
import { Cause, Context, Data, Duration, Effect, Layer, Option, Schedule, Stream } from "effect";
import type { Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { systemCommandOrigin } from "../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";

const SWEEP_INTERVAL = "1 minute";
// A turn's last words land just after the session reports ready, and a queued
// message goes out then too: give both the moment they need.
const SETTLE_DELAY_MS = 1_500;
const SESSION_GRACE_MS = 5 * 60_000;

/** Events after which a goal is over: someone decided. Our own commands don't count. */
const ENDING_EVENT_TYPES: ReadonlyMap<string, string> = new Map([
  ["thread.turn-interrupt-requested", "Stopped."],
  ["thread.session-stop-requested", "Stopped."],
  ["thread.reverted", "Stopped: the chat went back to an earlier point."],
  ["thread.archived", "Stopped: the chat was archived."],
  ["thread.deleted", "Stopped: the chat was deleted."],
]);

export class ThreadGoalRefused extends Data.TaggedError("ThreadGoalRefused")<{
  readonly message: string;
}> {}

export interface ThreadGoalShape {
  /** Registers a goal for the turn that is about to start, or has. */
  readonly set: (input: {
    readonly threadId: ThreadId;
    readonly goal: string;
  }) => Effect.Effect<ThreadGoalState, ThreadGoalRefused>;
  /** Stops the goal and the turn working on it. */
  readonly stop: (threadId: ThreadId) => Effect.Effect<OrchestrationStopThreadGoalResult>;
  /** Watch the chats. Must run in a scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ThreadGoal extends Context.Service<ThreadGoal, ThreadGoalShape>()(
  "t3/goal/ThreadGoalService",
) {}

interface GoalRow {
  readonly goalId: string;
  readonly threadId: ThreadId;
  readonly goal: string;
  readonly nonce: string;
  readonly status: ThreadGoalStatus;
  readonly turnsUsed: number;
  readonly maxTurns: number;
  readonly costUsd: number | null;
  readonly lastReportedCostUsd: number | null;
  readonly maxCostUsd: number;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly lastTurnId: TurnId | null;
  readonly endNote: string | null;
}

const toState = (row: GoalRow): ThreadGoalState => ({
  goalId: row.goalId,
  goal: row.goal,
  status: row.status,
  turnsUsed: row.turnsUsed,
  maxTurns: row.maxTurns,
  costUsd: row.costUsd,
  maxCostUsd: row.maxCostUsd,
  startedAt: row.startedAt,
  deadlineAt: row.deadlineAt,
  endNote: row.endNote,
  lastTurnId: row.lastTurnId,
});

export interface ThreadGoalLayerOptions {
  /** Tests: the clock. */
  readonly now?: () => number;
  /** Tests: no waiting for a turn's last words. */
  readonly settleDelayMs?: number;
}

export const makeThreadGoal = (options: ThreadGoalLayerOptions = {}) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const sql = yield* SqlClient.SqlClient;
    const nowMs = options.now ?? Date.now;
    const settleDelayMs = options.settleDelayMs ?? SETTLE_DELAY_MS;
    const iso = (ms: number) => new Date(ms).toISOString();
    // The last total a provider reported per chat, for what a goal adds to it.
    const reportedCostByThread = new Map<string, number>();

    const columns = sql`
      goal_id AS "goalId", thread_id AS "threadId", goal, nonce, status,
      turns_used AS "turnsUsed", max_turns AS "maxTurns", cost_usd AS "costUsd",
      last_reported_cost_usd AS "lastReportedCostUsd", max_cost_usd AS "maxCostUsd",
      started_at AS "startedAt", deadline_at AS "deadlineAt",
      last_turn_id AS "lastTurnId", end_note AS "endNote"
    `;

    const readActive = (threadId: string) =>
      sql<GoalRow>`
        SELECT ${columns} FROM thread_goals WHERE thread_id = ${threadId} AND status = 'active'
      `.pipe(Effect.map((rows) => rows[0] ?? null));

    const readById = (goalId: string) =>
      sql<GoalRow>`SELECT ${columns} FROM thread_goals WHERE goal_id = ${goalId}`.pipe(
        Effect.map((rows) => rows[0] ?? null),
      );

    const holdsOutsideInput = (threadId: string) =>
      sql`
        SELECT 1 FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND role = 'user' AND instr(text, '<outside_input_') > 0
        LIMIT 1
      `.pipe(Effect.map((rows) => rows.length > 0));

    const latestAssistantText = (threadId: string) =>
      sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND role = 'assistant'
        ORDER BY created_at DESC, message_id DESC
        LIMIT 1
      `.pipe(Effect.map((rows) => rows[0]?.text ?? ""));

    const summaryOf = (row: GoalRow) =>
      row.status === "active" ? `Goal: turn ${row.turnsUsed} of ${row.maxTurns}` : row.endNote;

    /** Clients learn the state from here. Losing a line must not stop the goal. */
    const publish = (goalId: string) =>
      Effect.gen(function* () {
        const row = yield* readById(goalId);
        if (!row) return;
        const createdAt = iso(nowMs());
        yield* engine.dispatch(
          {
            type: "thread.activity.append",
            commandId: CommandId.make(`${GOAL_COMMAND_PREFIX}activity:${crypto.randomUUID()}`),
            threadId: row.threadId,
            activity: {
              id: EventId.make(crypto.randomUUID()),
              tone: "info",
              kind: THREAD_GOAL_ACTIVITY_KIND,
              summary: summaryOf(row) ?? "Goal",
              payload: toState(row),
              turnId: null,
              createdAt,
            },
            createdAt,
          },
          { origin: systemCommandOrigin(GOAL_ORIGIN_COMPONENT, row.status) },
        );
      }).pipe(Effect.ignoreCause({ log: true }));

    const finish = (row: GoalRow, status: ThreadGoalStatus, note: string) =>
      Effect.gen(function* () {
        yield* sql`
          UPDATE thread_goals
          SET status = ${status}, end_note = ${note}, updated_at = ${iso(nowMs())}
          WHERE goal_id = ${row.goalId} AND status = 'active'
        `;
        yield* publish(row.goalId);
        yield* Effect.logInfo("goal: ended").pipe(
          Effect.annotateLogs({ threadId: row.threadId, status, turns: row.turnsUsed }),
        );
      });

    const continueGoal = (row: GoalRow, turnId: TurnId | null) =>
      Effect.gen(function* () {
        const shell = yield* projections
          .getThreadShellById(row.threadId)
          .pipe(Effect.map(Option.getOrNull));
        if (!shell) return;
        const turn = row.turnsUsed + 1;
        yield* sql`
          UPDATE thread_goals
          SET turns_used = ${turn}, last_turn_id = ${turnId}, updated_at = ${iso(nowMs())}
          WHERE goal_id = ${row.goalId} AND status = 'active'
        `;
        yield* engine.dispatch(
          {
            type: "thread.turn.start",
            commandId: CommandId.make(`${GOAL_COMMAND_PREFIX}${crypto.randomUUID()}`),
            threadId: row.threadId,
            message: {
              messageId: MessageId.make(crypto.randomUUID()),
              role: "user",
              text: `${UNO_WORK_NOTE_PREFIX}${goalNoteBody({
                goal: row.goal,
                nonce: row.nonce,
                turn,
                maxTurns: row.maxTurns,
              })}`,
              attachments: [],
            },
            // The chat's own modes, read now: a goal never raises them.
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
            createdAt: iso(nowMs()),
          },
          { origin: systemCommandOrigin(GOAL_ORIGIN_COMPONENT, `turn ${turn} of ${row.maxTurns}`) },
        );
        yield* publish(row.goalId);
      });

    /** The chat is idle after a turn this goal has not looked at: end it or go on. */
    const considerGoal = (threadId: string) =>
      Effect.gen(function* () {
        const row = yield* readActive(threadId);
        if (!row) return;
        const shell = yield* projections
          .getThreadShellById(row.threadId)
          .pipe(Effect.map(Option.getOrNull));
        if (!shell) {
          yield* finish(row, "stopped", "Stopped: the chat is gone.");
          return;
        }
        const session = shell.session;
        if (session?.status === "error") {
          yield* finish(row, "failed", "Stopped: the agent hit an error.");
          return;
        }
        // Still busy, or waiting for the person (an approval, a question).
        if (
          session?.status !== "ready" ||
          session.activeTurnId !== null ||
          shell.hasPendingApprovals ||
          shell.hasPendingUserInput
        ) {
          return;
        }
        const turnId = shell.latestTurn?.turnId ?? null;
        if (turnId === null || turnId === row.lastTurnId) return;
        if (shell.latestTurn?.state === "interrupted") {
          yield* finish(row, "stopped", "Stopped.");
          return;
        }
        if (shell.latestTurn?.state === "error") {
          yield* finish(row, "failed", "Stopped: the agent hit an error.");
          return;
        }
        const step = decideGoalStep({
          progress: {
            turnsUsed: row.turnsUsed,
            maxTurns: row.maxTurns,
            costUsd: row.costUsd,
            maxCostUsd: row.maxCostUsd,
            deadlineMs: Date.parse(row.deadlineAt),
          },
          verdict: readGoalVerdict(yield* latestAssistantText(row.threadId), row.nonce),
          holdsOutsideInput: yield* holdsOutsideInput(row.threadId),
          now: nowMs(),
        });
        if (step.next === "end") {
          yield* sql`
            UPDATE thread_goals SET last_turn_id = ${turnId} WHERE goal_id = ${row.goalId}
          `;
          yield* finish(row, step.status, step.note);
          return;
        }
        yield* continueGoal(row, turnId);
      });

    const guarded = <E, R>(what: string, effect: Effect.Effect<void, E, R>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning(`goal: ${what} failed`).pipe(
                Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              ),
        ),
      );

    const onDomainEvent = (event: OrchestrationEvent) => {
      const threadId = event.aggregateId as string;
      const endNote = ENDING_EVENT_TYPES.get(event.type);
      if (endNote !== undefined) {
        if (event.commandId?.startsWith(GOAL_COMMAND_PREFIX)) return Effect.void;
        return Effect.flatMap(readActive(threadId), (row) =>
          row ? finish(row, "stopped", endNote) : Effect.void,
        );
      }
      if (event.type !== "thread.session-set") return Effect.void;
      const status = event.payload.session.status;
      if (status !== "ready" && status !== "error") return Effect.void;
      return Effect.flatMap(readActive(threadId), (row) =>
        row
          ? Effect.sleep(Duration.millis(settleDelayMs)).pipe(
              Effect.andThen(considerGoal(threadId)),
            )
          : Effect.void,
      );
    };

    const onRuntimeEvent = (event: ProviderRuntimeEvent) => {
      if (event.type !== "turn.completed") return Effect.void;
      const reported = event.payload.totalCostUsd;
      if (typeof reported !== "number") return Effect.void;
      const threadId = event.threadId as string;
      return Effect.gen(function* () {
        const row = yield* readActive(threadId);
        const seen = reportedCostByThread.get(threadId) ?? row?.lastReportedCostUsd ?? null;
        reportedCostByThread.set(threadId, reported);
        if (!row) return;
        const cost = addReportedCost(
          { usedUsd: row.costUsd ?? 0, lastReportedUsd: seen },
          reported,
        );
        yield* sql`
          UPDATE thread_goals
          SET cost_usd = ${cost.usedUsd}, last_reported_cost_usd = ${cost.lastReportedUsd}
          WHERE goal_id = ${row.goalId}
        `;
      });
    };

    /** Goals nothing will wake: a restart lost the turn, or the time ran out while idle. */
    const sweep = Effect.gen(function* () {
      const rows = yield* sql<GoalRow>`SELECT ${columns} FROM thread_goals WHERE status = 'active'`;
      for (const row of rows) {
        const shell = yield* projections
          .getThreadShellById(row.threadId)
          .pipe(Effect.map(Option.getOrNull));
        const status = shell?.session?.status ?? null;
        // A new chat has no session for its first moments (a worktree to prepare).
        const young = nowMs() - Date.parse(row.startedAt) < SESSION_GRACE_MS;
        if (!shell || status === "stopped" || status === "error" || (status === null && !young)) {
          yield* finish(row, "failed", "Stopped: the agent's session ended.");
          continue;
        }
        if (status === "interrupted") {
          yield* finish(row, "stopped", "Stopped.");
          continue;
        }
        const idle = status === "ready" && shell.session?.activeTurnId === null;
        if (idle && nowMs() >= Date.parse(row.deadlineAt)) {
          yield* finish(row, "limit", `Stopped at the ${GOAL_MAX_MINUTES} minute limit.`);
          continue;
        }
        if (idle) yield* considerGoal(row.threadId);
      }
    });

    const set: ThreadGoalShape["set"] = ({ threadId, goal }) =>
      Effect.gen(function* () {
        const shell = yield* projections
          .getThreadShellById(threadId)
          .pipe(Effect.map(Option.getOrNull));
        if (!shell || shell.archivedAt !== null) {
          return yield* new ThreadGoalRefused({ message: "This chat is gone." });
        }
        if (shell.assistantRole) {
          return yield* new ThreadGoalRefused({ message: "Assistants don't take goals." });
        }
        if (yield* holdsOutsideInput(threadId)) {
          return yield* new ThreadGoalRefused({
            message: "A goal can't run in a chat with text from outside, like a form or webhook.",
          });
        }
        const previous = yield* readActive(threadId);
        if (previous) yield* finish(previous, "stopped", "Replaced by a new goal.");
        const now = nowMs();
        const goalId = crypto.randomUUID();
        // The turn that is about to start is a new one: whatever ended before it is not.
        yield* sql`
          INSERT INTO thread_goals (
            goal_id, thread_id, goal, nonce, status, turns_used, max_turns, cost_usd,
            last_reported_cost_usd, max_cost_usd, started_at, deadline_at, last_turn_id,
            updated_at
          )
          VALUES (
            ${goalId}, ${threadId}, ${goal}, ${crypto.randomUUID().slice(0, 6)}, 'active', 1,
            ${GOAL_MAX_TURNS}, ${null}, ${reportedCostByThread.get(threadId) ?? null},
            ${GOAL_MAX_COST_USD}, ${iso(now)}, ${iso(now + GOAL_MAX_MINUTES * 60_000)},
            ${shell.latestTurn?.turnId ?? null}, ${iso(now)}
          )
        `;
        yield* publish(goalId);
        const row = yield* readById(goalId);
        if (!row) return yield* new ThreadGoalRefused({ message: "Could not save the goal." });
        return toState(row);
      }).pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.logWarning("goal: could not save").pipe(
            Effect.annotateLogs({ cause: String(cause) }),
            Effect.andThen(
              Effect.fail(new ThreadGoalRefused({ message: "Could not save the goal." })),
            ),
          ),
        ),
      );

    const stop: ThreadGoalShape["stop"] = (threadId) =>
      Effect.gen(function* () {
        const row = yield* readActive(threadId);
        if (!row) return { stopped: false };
        yield* finish(row, "stopped", "Stopped.");
        const shell = yield* projections
          .getThreadShellById(threadId)
          .pipe(Effect.map(Option.getOrNull));
        const activeTurnId = shell?.session?.activeTurnId ?? null;
        if (activeTurnId !== null) {
          yield* engine.dispatch(
            {
              type: "thread.turn.interrupt",
              commandId: CommandId.make(`${GOAL_COMMAND_PREFIX}stop:${crypto.randomUUID()}`),
              threadId,
              turnId: activeTurnId,
              createdAt: iso(nowMs()),
            },
            { origin: systemCommandOrigin(GOAL_ORIGIN_COMPONENT, "stop") },
          );
        }
        return { stopped: true };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("goal: stop failed").pipe(
            Effect.annotateLogs({ cause: Cause.pretty(cause) }),
            Effect.as({ stopped: false }),
          ),
        ),
      );

    const startWith = (providerEvents: Stream.Stream<ProviderRuntimeEvent>) =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Stream.runForEach(engine.streamDomainEvents, (event) =>
            guarded("event", onDomainEvent(event)),
          ),
        );
        yield* Effect.forkScoped(
          Stream.runForEach(providerEvents, (event) => guarded("cost", onRuntimeEvent(event))),
        );
        yield* Effect.forkScoped(
          guarded("sweep", sweep).pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))),
        );
      });

    return { set, stop, startWith, onDomainEvent, onRuntimeEvent, sweep, considerGoal };
  });

export const ThreadGoalLive = Layer.effect(
  ThreadGoal,
  Effect.gen(function* () {
    const service = yield* makeThreadGoal();
    const provider = yield* ProviderService;
    return {
      set: service.set,
      stop: service.stop,
      start: () => service.startWith(provider.streamEvents),
    } satisfies ThreadGoalShape;
  }),
);
