/**
 * PlanResumeService — a chat stopped by the limit of the person's own Claude
 * or ChatGPT plan goes on by itself once the plan resets ("Resumes at 16:40 ·
 * Cancel"; upstream UsageLimitRecoveryWorker, 60f2246358).
 *
 * Lives on the daemon, so it works with Uno Work closed as long as the daemon
 * runs. The wait is a row in `plan_resumes`: it survives a restart, and on a
 * computer that sleeps an overdue row fires right after it wakes — this
 * service cannot wake a computer and doesn't pretend to.
 *
 * Listens to domain events only, like TurnAutoRetry: a turn's end is seen on
 * `thread.session-set` (Codex's error) and on the final assistant message
 * (Claude Code ends the turn with its stop line as a short reply, finished
 * after the session is already "ready"). The chat learns about the wait from
 * two activities (`plan-limit.resume-*`), which every open window receives.
 *
 * @module planResume/PlanResumeService
 */
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import {
  PLAN_RESUME_ENDED_ACTIVITY,
  PLAN_RESUME_GRACE_MS,
  PLAN_RESUME_MESSAGE_PREFIX,
  PLAN_RESUME_NOTE_BODY,
  PLAN_RESUME_SCHEDULED_ACTIVITY,
  planAccountForInstance,
  planAtLimit,
  planProviderForDriver,
  planResumeTime,
} from "@t3tools/shared/planLimitRules";
import { UNO_WORK_NOTE_PREFIX } from "@t3tools/shared/secretRequestCopy";
import { Cause, Context, Duration, Effect, Layer, Option, Schedule, Stream } from "effect";
import type { Scope } from "effect";

import { systemCommandOrigin } from "../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PlanLimitsService } from "../planLimits/PlanLimitsService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makePlanResumeRepository } from "./planResumeRepository.ts";
import {
  decideDue,
  hadItsTry,
  stopLineOf,
  type PlanResumeRow,
  type ThreadState,
} from "./planResumeRules.ts";

const SWEEP_INTERVAL = Duration.seconds(30);
const SWEEP_BATCH = 25;
const COMPONENT = "plan-resume";
/** At the stop and at the reset the numbers matter: at most this old. */
const FRESH_NUMBERS_MS = 30_000;

/** Domain events that end a wait: someone else decided. Our own continuation doesn't count. */
const ENDING_EVENT_TYPES: ReadonlyMap<string, string> = new Map([
  ["thread.turn-start-requested", "person-went-on"],
  ["thread.turn-interrupt-requested", "person-stopped"],
  ["thread.session-stop-requested", "person-stopped"],
  ["thread.reverted", "person-went-on"],
  ["thread.archived", "chat-gone"],
  ["thread.deleted", "chat-gone"],
]);

export interface PlanResumeShape {
  /** The person pressed Cancel, or took the chat elsewhere. False: nothing was waiting. */
  readonly cancel: (threadId: ThreadId, reason: string) => Effect.Effect<boolean>;
  /** Watch the chats and sweep due waits. Must run in a scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class PlanResume extends Context.Service<PlanResume, PlanResumeShape>()(
  "t3/planResume/PlanResumeService",
) {}

const stateOf = (shell: OrchestrationThreadShell): ThreadState => ({
  archived: shell.archivedAt !== null,
  sessionStatus: shell.session?.status ?? null,
  activeTurnId: shell.session?.activeTurnId ?? null,
  latestTurnId: shell.latestTurn?.turnId ?? null,
  latestTurnState: shell.latestTurn?.state ?? null,
});

export interface PlanResumeLayerOptions {
  /** Tests: the clock. */
  readonly now?: () => number;
}

export const makePlanResume = (options: PlanResumeLayerOptions = {}) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const settings = yield* ServerSettingsService;
    const planLimits = yield* PlanLimitsService;
    const repository = yield* makePlanResumeRepository;
    const nowMs = options.now ?? Date.now;
    const iso = (ms: number) => new Date(ms).toISOString();

    const isOn = settings.getSettings.pipe(
      Effect.map((current) => current.resumeAfterPlanLimit),
      // A hiccup reading the settings isn't the person saying no.
      Effect.orElseSucceed(() => true),
    );

    const appendActivity = (input: {
      readonly threadId: ThreadId;
      readonly kind: string;
      readonly summary: string;
      readonly payload: Record<string, unknown>;
    }) => {
      const createdAt = iso(nowMs());
      return engine
        .dispatch(
          {
            type: "thread.activity.append",
            commandId: CommandId.make(`${COMPONENT}-activity:${crypto.randomUUID()}`),
            threadId: input.threadId,
            activity: {
              id: EventId.make(crypto.randomUUID()),
              tone: "info",
              kind: input.kind,
              summary: input.summary,
              payload: input.payload,
              turnId: null,
              createdAt,
            },
            createdAt,
          },
          { origin: systemCommandOrigin(COMPONENT, input.kind) },
        )
        .pipe(Effect.asVoid);
    };

    const announce = (threadId: ThreadId, resumeAt: string, source: string) =>
      appendActivity({
        threadId,
        kind: PLAN_RESUME_SCHEDULED_ACTIVITY,
        summary: "Resumes after the plan's limit",
        payload: { resumeAt, source },
      });

    const endWait = (row: PlanResumeRow, status: "cancelled" | "failed", reason: string) =>
      Effect.gen(function* () {
        const ended = yield* repository.end({
          resumeId: row.resumeId,
          status,
          reason,
          now: iso(nowMs()),
        });
        if (!ended) return false;
        yield* appendActivity({
          threadId: row.threadId,
          kind: PLAN_RESUME_ENDED_ACTIVITY,
          summary: "Won't resume by itself",
          payload: { reason },
        });
        yield* Effect.logInfo("plan resume: wait ended").pipe(
          Effect.annotateLogs({ threadId: row.threadId, reason }),
        );
        return true;
      });

    const readShell = (threadId: ThreadId) =>
      projections.getThreadShellById(threadId).pipe(Effect.map(Option.getOrNull));

    /** The chat's account now; numbers at most `FRESH_NUMBERS_MS` old. */
    const accountOf = (shell: OrchestrationThreadShell) =>
      Effect.gen(function* () {
        const provider = planProviderForDriver(shell.session?.providerName);
        if (provider === null) return null;
        const limits = yield* planLimits.read({}, { maxAgeMs: FRESH_NUMBERS_MS });
        return planAccountForInstance(
          limits.accounts,
          provider,
          shell.session?.providerInstanceId ?? shell.modelSelection.instanceId,
        );
      });

    const considerStop = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const shell = yield* readShell(threadId);
        if (shell === null) return;
        if (planProviderForDriver(shell.session?.providerName) === null) return;
        const tail = yield* repository.threadTail(threadId);
        const stopText = stopLineOf({
          state: stateOf(shell),
          tail,
          sessionError: shell.session?.lastError ?? null,
          now: nowMs(),
        });
        if (stopText === null) return;
        if (!(yield* isOn)) return;
        if (hadItsTry(tail)) {
          yield* Effect.logInfo(
            "plan resume: limit again right after a resume, the person decides",
          ).pipe(Effect.annotateLogs({ threadId }));
          return;
        }
        const { lastUserMessageId } = tail;
        if (yield* repository.caseSeen({ threadId, lastUserMessageId })) return;

        const account = yield* accountOf(shell);
        const time = planResumeTime({ account, stopText, now: nowMs() });
        if (time.kind !== "at") {
          yield* Effect.logInfo("plan resume: no reset time, not scheduled").pipe(
            Effect.annotateLogs({ threadId, why: time.kind }),
          );
          return;
        }
        const resumeId = crypto.randomUUID();
        yield* repository.insert({
          resumeId,
          threadId,
          stoppedTurnId: shell.latestTurn?.turnId ?? null,
          lastUserMessageId,
          resumeAt: time.resumeAt,
          now: iso(nowMs()),
        });
        yield* announce(threadId, time.resumeAt, time.source);
        yield* Effect.logInfo("plan resume: scheduled").pipe(
          Effect.annotateLogs({ threadId, resumeAt: time.resumeAt, source: time.source }),
        );
      });

    const dispatchResume = (row: PlanResumeRow, shell: OrchestrationThreadShell) =>
      Effect.gen(function* () {
        const createdAt = iso(nowMs());
        const id = `${PLAN_RESUME_MESSAGE_PREFIX}${row.resumeId}`;
        // First, so a crash after it can't make a second try: at most once.
        const mine = yield* repository.end({
          resumeId: row.resumeId,
          status: "dispatched",
          reason: "resumed",
          now: createdAt,
        });
        if (!mine) return;
        yield* appendActivity({
          threadId: row.threadId,
          kind: PLAN_RESUME_ENDED_ACTIVITY,
          summary: "Resumed after the plan's limit",
          payload: { reason: "resumed" },
        });
        yield* engine.dispatch(
          {
            type: "thread.turn.start",
            commandId: CommandId.make(id),
            threadId: row.threadId,
            message: {
              messageId: MessageId.make(id),
              role: "user",
              text: `${UNO_WORK_NOTE_PREFIX}${PLAN_RESUME_NOTE_BODY}`,
              attachments: [],
            },
            runtimeMode: shell.runtimeMode,
            interactionMode: shell.interactionMode,
            createdAt,
          },
          { origin: systemCommandOrigin(COMPONENT, "plan limit reset") },
        );
        yield* Effect.logInfo("plan resume: resumed").pipe(
          Effect.annotateLogs({ threadId: row.threadId }),
        );
      });

    const fire = (row: PlanResumeRow) =>
      Effect.gen(function* () {
        const shell = yield* readShell(row.threadId);
        const tail = yield* repository.threadTail(row.threadId);
        const decision = decideDue({
          row,
          state: shell === null ? null : stateOf(shell),
          tail,
        });
        if (decision.kind === "end" || shell === null) {
          yield* endWait(row, "cancelled", decision.kind === "end" ? decision.reason : "chat-gone");
          return;
        }
        // Another window filled up meanwhile (the weekly one): wait for that
        // one, the single try isn't spent on a wall we can see.
        const now = nowMs();
        const account = yield* accountOf(shell);
        const hit = account && !account.stale ? planAtLimit(account, now) : null;
        const until = hit?.resetsAt ? Date.parse(hit.resetsAt) : Number.NaN;
        if (Number.isFinite(until) && until > now) {
          const resumeAt = iso(until + PLAN_RESUME_GRACE_MS);
          yield* repository.reschedule({ resumeId: row.resumeId, resumeAt, now: iso(now) });
          yield* announce(row.threadId, resumeAt, "plan");
          return;
        }
        yield* dispatchResume(row, shell);
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("plan resume: could not resume").pipe(
                Effect.annotateLogs({ threadId: row.threadId, cause: Cause.pretty(cause) }),
                Effect.andThen(endWait(row, "failed", "could-not-resume").pipe(Effect.ignore)),
              ),
        ),
      );

    const sweep = Effect.gen(function* () {
      if (!(yield* isOn)) {
        // Turned off with chats waiting: they stop waiting now, not at the reset.
        for (const row of yield* repository.listPending(SWEEP_BATCH)) {
          yield* endWait(row, "cancelled", "setting-off");
        }
        return;
      }
      for (const row of yield* repository.listDue({ now: iso(nowMs()), limit: SWEEP_BATCH })) {
        yield* fire(row);
      }
    });

    const cancel: PlanResumeShape["cancel"] = (threadId, reason) =>
      repository.pendingForThread(threadId).pipe(
        Effect.flatMap((row) =>
          row === null ? Effect.succeed(false) : endWait(row, "cancelled", reason),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("plan resume: could not cancel").pipe(
            Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
            Effect.as(false),
          ),
        ),
      );

    /** A person (or anyone but this service) moved the chat on. */
    const onDomainEvent = (event: OrchestrationEvent) => {
      const threadId = event.aggregateId as ThreadId;
      const endReason = ENDING_EVENT_TYPES.get(event.type);
      if (endReason !== undefined) {
        if (event.commandId?.startsWith(PLAN_RESUME_MESSAGE_PREFIX)) return Effect.void;
        return cancel(threadId, endReason).pipe(Effect.asVoid);
      }
      const turnMayHaveEnded =
        (event.type === "thread.session-set" &&
          (event.payload.session.status === "ready" || event.payload.session.status === "error")) ||
        (event.type === "thread.message-sent" &&
          event.payload.role === "assistant" &&
          !event.payload.streaming);
      if (!turnMayHaveEnded) return Effect.void;
      return considerStop(threadId);
    };

    const start: PlanResumeShape["start"] = () =>
      Effect.gen(function* () {
        const guarded = <E, R>(what: string, effect: Effect.Effect<void, E, R>) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logWarning(`plan resume: ${what} failed`).pipe(
                    Effect.annotateLogs({ cause: Cause.pretty(cause) }),
                  ),
            ),
          );
        yield* Effect.forkScoped(
          Stream.runForEach(engine.streamDomainEvents, (event) =>
            guarded("event", onDomainEvent(event)),
          ),
        );
        yield* Effect.forkScoped(
          guarded("sweep", sweep).pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))),
        );
      });

    return { cancel, start, sweep, onDomainEvent };
  });

export const PlanResumeLive = Layer.effect(
  PlanResume,
  makePlanResume().pipe(
    Effect.map(({ cancel, start }) => ({ cancel, start }) satisfies PlanResumeShape),
  ),
);
