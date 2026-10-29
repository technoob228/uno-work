/**
 * Updating Uno Work must not silently kill what agents are doing.
 *
 * The root updater (deploy/install.sh) ends with `systemctl stop uno-work`,
 * and every harness lives in that unit's cgroup: an agent mid-turn dies with
 * the daemon. A customer's Claude stopped mid-work right when "Uno Work is
 * updated to 0.0.161" appeared, and the chat looked frozen (28.10.2026).
 * So, around an update:
 *
 * 1. **Ask first.** The status route says how many agents work right now
 *    ({@link workingTurnsOf}); the app offers "Update when they finish".
 * 2. **Wait for them.** That request is a file in the daemon's state
 *    ({@link DeferredUpdate}); the daemon asks the root updater itself once
 *    no agent has worked for a moment, or after
 *    {@link DEFERRED_UPDATE_MAX_WAIT_MS} anyway ({@link decideDeferredUpdate}).
 * 3. **Remember who was cut off.** While an update is on its way the daemon
 *    that is about to be stopped keeps a snapshot of the working turns
 *    ({@link TurnsSnapshot}, refreshed every few seconds — taken BEFORE the
 *    stop: a harness dies at the same moment as the daemon, so whatever the
 *    projections say afterwards is not to be trusted).
 * 4. **Continue them.** The new daemon, started by that update
 *    ({@link isSelfUpdateRestart}), sends each of those chats one short
 *    continuation ({@link threadsToContinue}) — once per chat per update.
 *    A crash or a manual restart continues nothing: the chat shows
 *    "Stopped by a restart" and the person decides.
 *
 * Pure decisions and the small state files live here; the daemon loop and
 * the dispatch are in selfUpdateTurnsRuntime.ts.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { UpdaterStatus } from "./selfUpdate.ts";

/** "Update when they finish" never waits longer than this. */
export const DEFERRED_UPDATE_MAX_WAIT_MS = 30 * 60_000;
/**
 * No agent working for this long counts as "they finished": a manager agent
 * or a connector starts its next turn a moment after the last one ends.
 */
export const DEFERRED_UPDATE_IDLE_MS = 10_000;
/** The updater's own limit is 30 min; a run older than that did not restart us. */
const RUN_MAX_MS = 40 * 60_000;
/** A request waits up to 2 min for the updater; the snapshot may be that much older. */
const SNAPSHOT_LEAD_MS = 5 * 60_000;
/** Whole-second timestamps of the updater vs. our milliseconds. */
const CLOCK_SLACK_MS = 5_000;

const DEFERRED_FILE = "self-update-deferred.json";
const SNAPSHOT_FILE = "self-update-working-turns.json";
const CONTINUED_FILE = "self-update-continued.json";

// ── Who is working ──────────────────────────────────────────────────────

export interface WorkingTurn {
  readonly threadId: string;
  /** The turn that runs; null while it starts (or between auto-retries). */
  readonly turnId: string | null;
}

/** What the decisions need of a thread (`OrchestrationThread` fits). */
export interface TurnThreadView {
  readonly id: string;
  readonly archivedAt: string | null;
  readonly deletedAt?: string | null;
  readonly session: {
    readonly status: string;
    readonly activeTurnId: string | null;
  } | null;
  readonly latestTurn?: {
    readonly turnId: string;
    readonly state: string;
    readonly requestedAt: string;
  } | null;
}

function isWorking(session: TurnThreadView["session"]): boolean {
  return (
    session !== null &&
    (session.status === "starting" || session.status === "running" || session.activeTurnId !== null)
  );
}

/** The chats whose agent works right now: the same test as startup reconciliation. */
export function workingTurnsOf(threads: ReadonlyArray<TurnThreadView>): ReadonlyArray<WorkingTurn> {
  return threads
    .filter((thread) => !thread.deletedAt && isWorking(thread.session))
    .map((thread) => ({
      threadId: thread.id,
      turnId:
        thread.session?.activeTurnId ??
        (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null),
    }));
}

// ── "Update when they finish" ───────────────────────────────────────────

export interface DeferredUpdate {
  /** When the owner asked. */
  readonly requestedAt: string;
  /** The update starts by then whatever the agents do. */
  readonly deadlineAt: string;
}

export function deferredUpdateFor(now: number): DeferredUpdate {
  return {
    requestedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + DEFERRED_UPDATE_MAX_WAIT_MS).toISOString(),
  };
}

/**
 * Start the waiting update now? `idleSince`: since when no agent has been
 * working (null: one works right now).
 */
export function decideDeferredUpdate(input: {
  readonly deferred: DeferredUpdate;
  readonly idleSince: number | null;
  readonly now: number;
}): "wait" | "start" {
  const deadline = Date.parse(input.deferred.deadlineAt);
  if (!Number.isFinite(deadline) || input.now >= deadline) return "start";
  if (input.idleSince !== null && input.now - input.idleSince >= DEFERRED_UPDATE_IDLE_MS) {
    return "start";
  }
  return "wait";
}

// ── The snapshot and the continuation ───────────────────────────────────

export interface TurnsSnapshot {
  readonly takenAt: string;
  readonly turns: ReadonlyArray<WorkingTurn>;
}

/**
 * This daemon is the one the update will stop, so it keeps the snapshot:
 * the request still waits for the updater, or the updater started after
 * this process (the daemon it started has nothing to remember).
 */
export function shouldKeepSnapshot(input: {
  readonly inProgress: { readonly phase: "requested" | "updating"; readonly since: number } | null;
  readonly processStartedAt: number;
}): boolean {
  const progress = input.inProgress;
  if (progress === null) return false;
  return progress.phase === "requested" || progress.since > input.processStartedAt;
}

/**
 * This process was started by an update, and the snapshot is what the
 * daemon it replaced saw right before it was stopped.
 */
export function isSelfUpdateRestart(input: {
  readonly snapshot: TurnsSnapshot | null;
  readonly updater: UpdaterStatus | null;
  readonly processStartedAt: number;
}): boolean {
  const { snapshot, updater, processStartedAt } = input;
  if (!snapshot || !updater || updater.state === "current") return false;
  const started = updater.startedAt ? Date.parse(updater.startedAt) : Number.NaN;
  const taken = Date.parse(snapshot.takenAt);
  if (!Number.isFinite(started) || !Number.isFinite(taken)) return false;
  // The run began before this process and not long ago: it restarted us.
  if (started > processStartedAt + CLOCK_SLACK_MS) return false;
  if (processStartedAt - started > RUN_MAX_MS) return false;
  // The snapshot is the previous daemon's, from this run.
  if (taken > processStartedAt + CLOCK_SLACK_MS) return false;
  return taken >= started - SNAPSHOT_LEAD_MS;
}

/** The key of one update run: "once per chat per update" counts against it. */
export function updateRunKey(updater: UpdaterStatus | null): string | null {
  return updater?.startedAt ?? null;
}

/**
 * The chats to continue after an update restart. Not the ones somebody
 * already went on with (the person's own message, a connector re-run), not
 * a turn that had finished right before the stop, not a chat that is gone,
 * and never one already continued in this update.
 */
export function threadsToContinue(input: {
  readonly snapshot: TurnsSnapshot;
  readonly threads: ReadonlyArray<TurnThreadView>;
  readonly alreadyContinued: ReadonlySet<string>;
}): ReadonlyArray<WorkingTurn> {
  const taken = Date.parse(input.snapshot.takenAt);
  const byId = new Map(input.threads.map((thread) => [thread.id, thread]));
  const seen = new Set<string>();
  return input.snapshot.turns.filter((turn) => {
    if (seen.has(turn.threadId) || input.alreadyContinued.has(turn.threadId)) return false;
    seen.add(turn.threadId);
    const thread = byId.get(turn.threadId);
    if (!thread || thread.deletedAt || thread.archivedAt !== null) return false;
    if (isWorking(thread.session)) return false;
    const latest = thread.latestTurn ?? null;
    if (latest === null) return true;
    if (turn.turnId !== null && latest.turnId === turn.turnId) {
      return latest.state !== "completed";
    }
    // A turn requested after the snapshot: somebody already went on.
    const requested = Date.parse(latest.requestedAt);
    return !(Number.isFinite(requested) && requested > taken);
  });
}

// ── State files (the daemon's state dir) ────────────────────────────────

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function writeJson(stateDir: string, file: string, value: unknown): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, file);
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

export async function readDeferredUpdate(stateDir: string): Promise<DeferredUpdate | null> {
  const raw = await readJson(join(stateDir, DEFERRED_FILE));
  const requestedAt = text(raw?.["requestedAt"]);
  const deadlineAt = text(raw?.["deadlineAt"]);
  return requestedAt && deadlineAt ? { requestedAt, deadlineAt } : null;
}

export function writeDeferredUpdate(stateDir: string, deferred: DeferredUpdate): Promise<void> {
  return writeJson(stateDir, DEFERRED_FILE, deferred);
}

export async function clearDeferredUpdate(stateDir: string): Promise<void> {
  await rm(join(stateDir, DEFERRED_FILE), { force: true });
}

export async function readTurnsSnapshot(stateDir: string): Promise<TurnsSnapshot | null> {
  const raw = await readJson(join(stateDir, SNAPSHOT_FILE));
  const takenAt = text(raw?.["takenAt"]);
  const turns = raw?.["turns"];
  if (!takenAt || !Array.isArray(turns)) return null;
  return {
    takenAt,
    turns: turns.flatMap((turn: unknown) => {
      if (typeof turn !== "object" || turn === null) return [];
      const record = turn as Record<string, unknown>;
      const threadId = text(record["threadId"]);
      return threadId ? [{ threadId, turnId: text(record["turnId"]) }] : [];
    }),
  };
}

export function writeTurnsSnapshot(
  stateDir: string,
  turns: ReadonlyArray<WorkingTurn>,
  now: number,
): Promise<void> {
  return writeJson(stateDir, SNAPSHOT_FILE, {
    takenAt: new Date(now).toISOString(),
    turns,
  } satisfies TurnsSnapshot);
}

export async function clearTurnsSnapshot(stateDir: string): Promise<void> {
  await rm(join(stateDir, SNAPSHOT_FILE), { force: true });
}

/** The chats already continued in the update run `runKey`. */
export async function readContinuedThreads(
  stateDir: string,
  runKey: string,
): Promise<ReadonlySet<string>> {
  const raw = await readJson(join(stateDir, CONTINUED_FILE));
  if (raw?.["run"] !== runKey || !Array.isArray(raw["threadIds"])) return new Set();
  return new Set(raw["threadIds"].filter((id): id is string => typeof id === "string"));
}

export function writeContinuedThreads(
  stateDir: string,
  runKey: string,
  threadIds: ReadonlySet<string>,
): Promise<void> {
  return writeJson(stateDir, CONTINUED_FILE, { run: runKey, threadIds: [...threadIds] });
}
