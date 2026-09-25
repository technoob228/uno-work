/**
 * How many harness processes a machine can afford, and for how long an idle
 * one is kept.
 *
 * A cloud Uno Work computer has 2 GB of RAM: the daemon (~500 MB) plus a
 * harness per open chat (Codex, Claude, Hermes: a process per thread;
 * uno-code/OpenCode: one shared server) quickly runs it out of memory. So on
 * small machines idle harnesses are stopped sooner and the number of live
 * ones is capped. Stopping is invisible to the person: the thread keeps its
 * resume cursor and the next message starts the harness again on the same
 * conversation.
 *
 * Overrides (for support and experiments), read once at startup:
 * - `UNO_WORK_HARNESS_IDLE_MINUTES` — idle time before a harness is stopped;
 * - `UNO_WORK_MAX_LIVE_HARNESSES` — cap on live harness processes, `0` = none;
 * - `UNO_WORK_OPENCODE_SHARED_SERVER=0` — one OpenCode server per thread again.
 *
 * @module harnessBudget
 */
import * as os from "node:os";

const GIB = 1024 ** 3;
/** At or below this much RAM the machine counts as small. */
export const SMALL_MACHINE_MAX_MEMORY_BYTES = 4 * GIB;

const SMALL_MACHINE_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_MS = 15 * 60 * 1000;
const SMALL_MACHINE_MAX_LIVE = 3;
/** The reaper sweeps this often relative to the idle threshold (bounded). */
const SWEEP_FRACTION = 5;
const MIN_SWEEP_MS = 30 * 1000;
const MAX_SWEEP_MS = 5 * 60 * 1000;

export interface HarnessBudget {
  readonly inactivityThresholdMs: number;
  readonly sweepIntervalMs: number;
  /** `null` — no cap. */
  readonly maxLiveProcesses: number | null;
  readonly shareOpenCodeServer: boolean;
  readonly totalMemoryBytes: number;
}

function positiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function resolveHarnessBudget(input?: {
  readonly totalMemoryBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}): HarnessBudget {
  const env = input?.env ?? process.env;
  const totalMemoryBytes = input?.totalMemoryBytes ?? os.totalmem();
  const small = totalMemoryBytes <= SMALL_MACHINE_MAX_MEMORY_BYTES;

  const idleMinutes = positiveNumber(env.UNO_WORK_HARNESS_IDLE_MINUTES);
  const inactivityThresholdMs =
    idleMinutes !== undefined && idleMinutes > 0
      ? Math.round(idleMinutes * 60 * 1000)
      : small
        ? SMALL_MACHINE_IDLE_MS
        : DEFAULT_IDLE_MS;
  const sweepIntervalMs = Math.min(
    MAX_SWEEP_MS,
    Math.max(MIN_SWEEP_MS, Math.round(inactivityThresholdMs / SWEEP_FRACTION)),
  );

  const maxLiveOverride = positiveNumber(env.UNO_WORK_MAX_LIVE_HARNESSES);
  const maxLiveProcesses =
    maxLiveOverride !== undefined
      ? maxLiveOverride === 0
        ? null
        : Math.floor(maxLiveOverride)
      : small
        ? SMALL_MACHINE_MAX_LIVE
        : null;

  return {
    inactivityThresholdMs,
    sweepIntervalMs,
    maxLiveProcesses,
    shareOpenCodeServer: env.UNO_WORK_OPENCODE_SHARED_SERVER?.trim() !== "0",
    totalMemoryBytes,
  };
}

/** A live provider session, as the cap sees it. */
export interface LiveHarnessSession {
  readonly threadId: string;
  /** Adapter/instance the session runs on. */
  readonly instanceId: string;
  /** Sessions of this instance share one process (OpenCode shared server). */
  readonly sharesProcess: boolean;
  /** A turn is running or waiting for the person — never evicted. */
  readonly busy: boolean;
  /** Last activity (ms since epoch); older goes first. */
  readonly lastActivityMs: number;
}

/**
 * Which idle sessions to stop so that starting `incoming` keeps the number of
 * live harness processes within `maxLive`.
 *
 * A process is a per-thread session, or one shared server per instance with
 * live sessions. Only per-thread sessions are evicted (stopping one session of
 * a shared server frees nothing); busy ones never are. When everything is
 * busy the cap is exceeded rather than a running turn killed.
 */
export function selectSessionsToEvict(input: {
  readonly live: ReadonlyArray<LiveHarnessSession>;
  readonly incoming: {
    readonly threadId: string;
    readonly instanceId: string;
    readonly sharesProcess: boolean;
  };
  readonly maxLive: number;
}): ReadonlyArray<string> {
  // The incoming thread's previous session (restart) is replaced, not added.
  const others = input.live.filter((session) => session.threadId !== input.incoming.threadId);
  const sharedInstances = new Set(
    others.filter((session) => session.sharesProcess).map((session) => session.instanceId),
  );
  const processCount =
    others.filter((session) => !session.sharesProcess).length + sharedInstances.size;
  const addsProcess =
    !input.incoming.sharesProcess || !sharedInstances.has(input.incoming.instanceId);
  const excess = processCount + (addsProcess ? 1 : 0) - Math.max(1, input.maxLive);
  if (excess <= 0) return [];
  return others
    .filter((session) => !session.sharesProcess && !session.busy)
    .toSorted((a, b) => a.lastActivityMs - b.lastActivityMs)
    .slice(0, excess)
    .map((session) => session.threadId);
}

let cachedBudget: HarnessBudget | undefined;
/** The budget of this process (resolved once from RAM size and env). */
export function currentHarnessBudget(): HarnessBudget {
  cachedBudget ??= resolveHarnessBudget();
  return cachedBudget;
}
