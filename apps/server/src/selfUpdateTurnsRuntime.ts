/**
 * The daemon side of selfUpdateTurns.ts: the loop that holds "Update when
 * they finish" and keeps the snapshot of working turns while an update is on
 * its way, and the one-time continuation of those turns after the restart.
 *
 * Both run only where Uno Work updates itself (a cloud computer installed
 * with the updater drop-in); on a desktop or in dev they return at once.
 */
import { CommandId, MessageId, type OrchestrationThread, type ThreadId } from "@t3tools/contracts";
import { UNO_WORK_NOTE_PREFIX } from "@t3tools/shared/secretRequestCopy";
import { UPDATE_RESTART_NOTE_BODY } from "@t3tools/shared/turnErrorRetry";
import { Cause, Duration, Effect } from "effect";
import * as crypto from "node:crypto";

import { ServerConfig } from "./config.ts";
import { systemCommandOrigin } from "./orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorPendingReplyRepository } from "./persistence/Services/ManagerConnectorPendingReplies.ts";
import {
  selfUpdatePathsFromEnv,
  SelfUpdateUnavailableError,
  type SelfUpdateController,
  type SelfUpdateStatus,
} from "./selfUpdate.ts";
import { selfUpdateController } from "./selfUpdateController.ts";
import { noteSelfUpdateIntent } from "./selfUpdateJournal.ts";
import {
  clearDeferredUpdate,
  clearTurnsSnapshot,
  decideDeferredUpdate,
  isSelfUpdateRestart,
  readContinuedThreads,
  readDeferredUpdate,
  readTurnsSnapshot,
  shouldKeepSnapshot,
  threadsToContinue,
  updateRunKey,
  workingTurnsOf,
  writeContinuedThreads,
  writeTurnsSnapshot,
  type WorkingTurn,
} from "./selfUpdateTurns.ts";

/** When this daemon process started: tells "the update that restarted us" from "the one ahead". */
export const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1_000;

/** Command ids of the continuations sent after an update restart. */
export const SELF_UPDATE_CONTINUE_COMMAND_PREFIX = "self-update-continue:";
export const SELF_UPDATE_CONTINUE_ORIGIN_COMPONENT = "self-update-continue";

const WATCH_TICK = Duration.seconds(5);
/** The updater checks the new daemon for a few seconds before it calls the run done. */
const UPDATER_SETTLE_POLL_MS = 3_000;
const UPDATER_SETTLE_MAX_MS = 3 * 60_000;

/** The chats whose agent works right now. */
export const workingTurnsNow = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  const { threads } = yield* query.getCommandReadModel();
  return workingTurnsOf(threads);
});

/**
 * Ask the root updater to run now. The snapshot first: once the request is
 * written the updater may stop this daemon within the minute.
 */
export async function requestSelfUpdateNow(input: {
  readonly stateDir: string;
  readonly controller: SelfUpdateController;
  readonly turns: ReadonlyArray<WorkingTurn>;
  readonly now?: number;
}): Promise<SelfUpdateStatus> {
  await writeTurnsSnapshot(input.stateDir, input.turns, input.now ?? Date.now()).catch(
    () => undefined,
  );
  // The note first: the updater may start before `start()` returns.
  await noteSelfUpdateIntent(input.stateDir).catch(() => undefined);
  return input.controller.start();
}

/**
 * Every few seconds while there is something to watch: a waiting "Update
 * when they finish" (start it once the agents are done or the wait is over)
 * and an update on its way (refresh the snapshot of working turns). Run
 * forked; never fails.
 */
export const runSelfUpdateWatcher = Effect.gen(function* () {
  if (!selfUpdatePathsFromEnv()) return;
  const config = yield* ServerConfig;
  const tick = makeSelfUpdateWatcherTick({
    stateDir: config.stateDir,
    controller: selfUpdateController(),
    processStartedAt: PROCESS_STARTED_AT,
  });
  return yield* Effect.suspend(() => tick(Date.now())).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("self-update: watcher tick failed", { cause: Cause.pretty(cause) }),
    ),
    Effect.andThen(Effect.sleep(WATCH_TICK)),
    Effect.forever,
  );
});

/** One look of the watcher at `now`; keeps "since when nobody works" between looks. */
export function makeSelfUpdateWatcherTick(input: {
  readonly stateDir: string;
  readonly controller: SelfUpdateController;
  readonly processStartedAt: number;
}) {
  const { stateDir, controller } = input;
  let idleSince: number | null = null;

  return (now: number) =>
    Effect.gen(function* () {
      const [deferred, progress] = yield* Effect.promise(() =>
        Promise.all([readDeferredUpdate(stateDir), controller.inProgress()]),
      );
      const keepSnapshot = shouldKeepSnapshot({
        inProgress: progress,
        processStartedAt: input.processStartedAt,
      });
      if (deferred === null && !keepSnapshot) {
        idleSince = null;
        return;
      }
      const turns = yield* workingTurnsNow;
      if (keepSnapshot) {
        yield* Effect.promise(() => writeTurnsSnapshot(stateDir, turns, now));
      }
      if (deferred === null) return;
      if (progress !== null) {
        // "Update now" was pressed meanwhile: nothing to wait for any more.
        yield* Effect.promise(() => clearDeferredUpdate(stateDir));
        idleSince = null;
        return;
      }
      idleSince = turns.length === 0 ? (idleSince ?? now) : null;
      if (decideDeferredUpdate({ deferred, idleSince, now }) === "wait") return;
      const outcome = yield* Effect.promise(() =>
        requestSelfUpdateNow({ stateDir, controller, turns, now }).then(
          () => "started" as const,
          (cause: unknown) =>
            cause instanceof SelfUpdateUnavailableError ? ("unavailable" as const) : cause,
        ),
      );
      if (outcome === "started" || outcome === "unavailable") {
        yield* Effect.promise(() => clearDeferredUpdate(stateDir));
        idleSince = null;
        yield* Effect.logInfo(
          outcome === "started"
            ? "self-update: the waiting update started"
            : "self-update: the waiting update is no longer needed",
        ).pipe(Effect.annotateLogs({ workingAgents: turns.length }));
        return;
      }
      // A passing failure (disk): the next tick tries again.
      yield* Effect.logWarning("self-update: could not start the waiting update", {
        cause: outcome,
      });
    });
}

/** Telegram / Slack re-run a cut-off turn of their own (connectorReplies.ts). */
const hasOpenConnectorReply = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorPendingReplyRepository;
    const rows = yield* repository.listByThread({ threadId, limit: 50 });
    return rows.some((row) => row.status === "queued" || row.status === "waiting");
  }).pipe(
    // Unsure: let the connector's own watcher handle it rather than run twice.
    Effect.orElseSucceed(() => true),
  );

const dispatchContinuation = (thread: OrchestrationThread) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const createdAt = new Date().toISOString();
    yield* engine.dispatch(
      {
        type: "thread.turn.start",
        commandId: CommandId.make(`${SELF_UPDATE_CONTINUE_COMMAND_PREFIX}${crypto.randomUUID()}`),
        threadId: thread.id,
        message: {
          messageId: MessageId.make(crypto.randomUUID()),
          role: "user",
          text: `${UNO_WORK_NOTE_PREFIX}${UPDATE_RESTART_NOTE_BODY}`,
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt,
      },
      { origin: systemCommandOrigin(SELF_UPDATE_CONTINUE_ORIGIN_COMPONENT) },
    );
  });

/**
 * At daemon start, after startup reconciliation: the update that restarted
 * this daemon cut these agents off — send each one short continuation (the
 * provider session resumes from its saved cursor), once per chat per update.
 * Anything else (a crash, a manual restart) continues nothing. Run forked;
 * never fails.
 */
export const continueTurnsAfterSelfUpdate = Effect.gen(function* () {
  if (!selfUpdatePathsFromEnv()) return;
  const config = yield* ServerConfig;
  yield* continueTurnsAfterSelfUpdateWith({
    stateDir: config.stateDir,
    controller: selfUpdateController(),
    processStartedAt: PROCESS_STARTED_AT,
  });
});

export const continueTurnsAfterSelfUpdateWith = (input: {
  readonly stateDir: string;
  readonly controller: SelfUpdateController;
  readonly processStartedAt: number;
}) =>
  Effect.gen(function* () {
    const { stateDir, controller, processStartedAt } = input;
    const snapshot = yield* Effect.promise(() => readTurnsSnapshot(stateDir));
    if (snapshot === null) return;

    let updater = yield* Effect.promise(() => controller.lastRun());
    if (!isSelfUpdateRestart({ snapshot, updater, processStartedAt })) {
      // Not this restart's to act on. A snapshot for an update still ahead stays.
      const progress = yield* Effect.promise(() => controller.inProgress());
      if (!shouldKeepSnapshot({ inProgress: progress, processStartedAt })) {
        yield* Effect.promise(() => clearTurnsSnapshot(stateDir));
      }
      return;
    }
    const runKey = updateRunKey(updater);
    if (runKey === null) return;

    // While the updater still checks this daemon it may put the old version
    // back and stop us again: continue once it is satisfied (or gave no word).
    const deadline = Date.now() + UPDATER_SETTLE_MAX_MS;
    while (updater?.state === "updating" && !updater.finishedAt && Date.now() < deadline) {
      yield* Effect.sleep(Duration.millis(UPDATER_SETTLE_POLL_MS));
      updater = yield* Effect.promise(() => controller.lastRun());
    }

    const query = yield* ProjectionSnapshotQuery;
    const { threads } = yield* query.getCommandReadModel();
    const alreadyContinued = yield* Effect.promise(() => readContinuedThreads(stateDir, runKey));
    const candidates = threadsToContinue({ snapshot, threads, alreadyContinued });
    const byId = new Map(threads.map((thread) => [String(thread.id), thread]));
    const continued = new Set(alreadyContinued);
    let sent = 0;
    for (const turn of candidates) {
      const thread = byId.get(turn.threadId);
      if (!thread) continue;
      if (yield* hasOpenConnectorReply(thread.id)) continue;
      // Recorded before the dispatch: at most once, even if this daemon dies right after.
      continued.add(turn.threadId);
      yield* Effect.promise(() => writeContinuedThreads(stateDir, runKey, continued));
      const ok = yield* dispatchContinuation(thread).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("self-update: could not continue a chat", {
                threadId: thread.id,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
        ),
      );
      if (ok) sent += 1;
    }
    yield* Effect.promise(() => clearTurnsSnapshot(stateDir));
    if (snapshot.turns.length > 0) {
      yield* Effect.logInfo("self-update: continued the chats the update cut off").pipe(
        Effect.annotateLogs({ cutOff: snapshot.turns.length, continued: sent }),
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("self-update: continuing cut-off chats failed", {
            cause: Cause.pretty(cause),
          }),
    ),
  );
