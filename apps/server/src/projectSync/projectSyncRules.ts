/**
 * Pure rules of "On all my computers": when a project syncs (the scheduler)
 * and how its keys land in the project's `.env` (the merge). No I/O.
 *
 * @module projectSync/projectSyncRules
 */
import { upsertEnvContent, secretNameProblem } from "../secretsEnv.ts";

/** Why a project syncs now. */
export type SyncTrigger =
  /** an agent's turn in the project ended (its edits go to the other computers) */
  | "turn-end"
  /** a turn starts here: bring the other computers' changes first */
  | "turn-start"
  /** a file in the folder was saved; synced once the folder is quiet */
  | "file-save"
  /** Uno Work started */
  | "app-start"
  /** the person opened the project here */
  | "opened"
  /** a periodic look at the cloud */
  | "poll"
  /** the person asked (Sync now, the toggle, Get it here) */
  | "manual";

/** How long after a trigger the sync runs. `file-save` waits for quiet: each save restarts it. */
export const TRIGGER_DELAY_MS: Readonly<Record<SyncTrigger, number>> = {
  "turn-end": 2_000,
  "turn-start": 0,
  "file-save": 15_000,
  "app-start": 20_000,
  opened: 0,
  poll: 0,
  manual: 0,
};

/** Every enabled project looks at the cloud this often. */
export const POLL_EVERY_MS = 3 * 60_000;
/** Folder events right after our own sync are its own writes: ignored this long. */
export const OWN_WRITES_QUIET_MS = 3_000;

export interface SchedulerTimers {
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly now: () => number;
}

export interface SyncScheduler {
  /** Ask for a sync of `key` because of `trigger`. */
  readonly schedule: (key: string, trigger: SyncTrigger) => void;
  /** Run now (or right after the running one) and wait for that run. */
  readonly runNow: (key: string) => Promise<void>;
  readonly cancel: (key: string) => void;
  readonly isRunning: (key: string) => boolean;
  /** When the last run of `key` finished (ms), or null. */
  readonly lastFinishedAt: (key: string) => number | null;
  readonly stop: () => void;
}

interface Slot {
  timer: unknown;
  dueAt: number;
  running: Promise<void> | null;
  again: boolean;
  waiters: Array<() => void>;
  finishedAt: number | null;
}

/**
 * One sync per project at a time; triggers while it runs ask for one more
 * run after it (never two in parallel, never a queue of many). Delays merge
 * to the earliest, except `file-save`, which waits for the folder to be quiet.
 */
export function createSyncScheduler(input: {
  readonly run: (key: string) => Promise<void>;
  readonly timers: SchedulerTimers;
}): SyncScheduler {
  const slots = new Map<string, Slot>();
  let stopped = false;
  const slotOf = (key: string): Slot => {
    let slot = slots.get(key);
    if (!slot) {
      slot = { timer: null, dueAt: 0, running: null, again: false, waiters: [], finishedAt: null };
      slots.set(key, slot);
    }
    return slot;
  };

  const start = (key: string) => {
    const slot = slotOf(key);
    if (slot.timer !== null) input.timers.clearTimeout(slot.timer);
    slot.timer = null;
    if (stopped) return;
    if (slot.running) {
      slot.again = true;
      return;
    }
    const waiters = slot.waiters.splice(0);
    slot.running = input
      .run(key)
      .catch(() => undefined)
      .then(() => {
        slot.running = null;
        slot.finishedAt = input.timers.now();
        for (const done of waiters) done();
        if (slot.again && !stopped) {
          slot.again = false;
          start(key);
        } else if (slot.waiters.length > 0 && slot.timer === null) {
          start(key);
        }
      });
  };

  const arm = (key: string, delay: number, restart: boolean) => {
    const slot = slotOf(key);
    const dueAt = input.timers.now() + delay;
    if (slot.timer !== null) {
      if (!restart && slot.dueAt <= dueAt) return;
      input.timers.clearTimeout(slot.timer);
    }
    slot.dueAt = dueAt;
    slot.timer = input.timers.setTimeout(() => {
      slot.timer = null;
      start(key);
    }, delay);
  };

  return {
    schedule: (key, trigger) => {
      if (stopped) return;
      const delay = TRIGGER_DELAY_MS[trigger];
      if (delay === 0) {
        start(key);
        return;
      }
      arm(key, delay, trigger === "file-save");
    },
    runNow: (key) =>
      new Promise<void>((resolve) => {
        if (stopped) {
          resolve();
          return;
        }
        const slot = slotOf(key);
        slot.waiters.push(resolve);
        if (slot.running) slot.again = true;
        else start(key);
      }),
    cancel: (key) => {
      const slot = slots.get(key);
      if (slot?.timer != null) input.timers.clearTimeout(slot.timer);
      if (slot) {
        slot.timer = null;
        slot.again = false;
      }
    },
    isRunning: (key) => slots.get(key)?.running != null,
    lastFinishedAt: (key) => slots.get(key)?.finishedAt ?? null,
    stop: () => {
      stopped = true;
      for (const slot of slots.values()) {
        if (slot.timer !== null) input.timers.clearTimeout(slot.timer);
        slot.timer = null;
        for (const done of slot.waiters.splice(0)) done();
      }
    },
  };
}

// ── Keys in `.env` ──────────────────────────────────────────────────────

/** The active `NAME=value` assignments of a dotenv file (last one wins), raw values. */
export function envNames(content: string): ReadonlyArray<string> {
  const names = new Set<string>();
  for (const line of content.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names];
}

/** The value of one assignment, unquoted the way `formatEnvValue` writes it. */
export function envValue(content: string, name: string): string | null {
  let found: string | null = null;
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`);
  for (const line of content.split("\n")) {
    const match = pattern.exec(line);
    if (!match) continue;
    const raw = (match[1] ?? "").trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
      found = raw
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    } else if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      found = raw.slice(1, -1);
    } else {
      found = raw.replace(/\s+#.*$/, "");
    }
  }
  return found;
}

/**
 * The project's `.env` with the vault's keys in it: a key the vault has is
 * set to the vault's value (the vault is what travels between computers);
 * keys only this computer has stay as they are, comments and order too.
 * Names that change how programs start are never written.
 */
export function mergeEnvContent(
  local: string,
  vault: Readonly<Record<string, string>>,
): {
  readonly content: string;
  readonly added: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
} {
  let content = local;
  const added: string[] = [];
  const updated: string[] = [];
  const present = new Set(envNames(local));
  for (const [name, value] of Object.entries(vault).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (secretNameProblem(name) !== null) continue;
    if (present.has(name)) {
      if (envValue(content, name) === value) continue;
      updated.push(name);
    } else {
      added.push(name);
    }
    content = upsertEnvContent(content, name, value);
  }
  return { content, added, updated };
}
