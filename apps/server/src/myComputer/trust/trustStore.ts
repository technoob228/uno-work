/**
 * What the person set for agents on their computers, and what follows from
 * it at run time:
 * - settings (Settings → My computer): allowed folders and commands, how
 *   long one chat's Allow lasts, after how long without agent activity
 *   access pauses — in `<stateDir>/my-computer/trust.json` (0600), next to
 *   the journal, with the pause and the last activity (a restart keeps both);
 * - chats' Allows: in memory only. A restart of Uno Work drops them, so the
 *   next write asks again (the safe direction);
 * - the pause: `stopped` (the person pressed Stop: nothing runs until they
 *   resume), `idle` (nothing for `idleHours`: the next call asks).
 *
 * @module myComputer/trust/trustStore
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

import type {
  MyComputerChatGrant,
  MyComputerPause,
  MyComputerTrustSettings,
  MyComputerTrustState,
} from "@t3tools/contracts";

import { DEFAULT_ALLOWED_FOLDERS } from "./pathPolicy.ts";

export const DEFAULT_TRUST_SETTINGS: MyComputerTrustSettings = {
  allowedFolders: [...DEFAULT_ALLOWED_FOLDERS],
  allowedCommands: [
    "make",
    "just",
    "cmake --build",
    "ninja",
    "./gradlew",
    "vite",
    "next dev",
    "next build",
  ],
  grantHours: 4,
  idleHours: 12,
};

const HOUR_MS = 3_600_000;

const keyOf = (threadId: string, computerId: string) => `${computerId}\u0000${threadId}`;

export interface TrustStore {
  readonly settings: () => Promise<MyComputerTrustSettings>;
  /** Everything Settings shows; `running`: from the core. */
  readonly state: (running: number) => Promise<MyComputerTrustState>;
  readonly setSettings: (next: MyComputerTrustSettings) => Promise<void>;
  readonly grantActive: (threadId: string, computerId: string) => boolean;
  readonly grant: (input: {
    readonly threadId: string;
    readonly threadTitle: string;
    readonly computerId: string;
  }) => Promise<void>;
  readonly revoke: (threadId: string, computerId: string) => void;
  readonly revokeComputer: (computerId: string) => void;
  /** The pause now, idleness counted. */
  readonly paused: () => Promise<MyComputerPause | null>;
  readonly pause: (reason: MyComputerPause["reason"]) => Promise<void>;
  readonly resume: () => Promise<void>;
  /** An agent did something there: the idle clock starts over. */
  readonly touch: () => Promise<void>;
}

interface Persisted {
  readonly settings: MyComputerTrustSettings;
  readonly paused: MyComputerPause | null;
  readonly lastActivityAt: string | null;
}

const strings = (value: unknown, max: number, maxLength: number): string[] | null =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item.length <= maxLength)
        .slice(0, max)
    : null;

const intIn = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;

/** A file from disk, checked field by field: what doesn't fit is the default. */
export function parseTrustFile(text: string): Persisted {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    // A broken file: the defaults.
  }
  const settings =
    raw.settings !== null && typeof raw.settings === "object"
      ? (raw.settings as Record<string, unknown>)
      : {};
  const paused =
    raw.paused !== null && typeof raw.paused === "object"
      ? (raw.paused as Record<string, unknown>)
      : null;
  return {
    settings: {
      allowedFolders:
        strings(settings.allowedFolders, 100, 1024) ?? DEFAULT_TRUST_SETTINGS.allowedFolders,
      allowedCommands:
        strings(settings.allowedCommands, 200, 200) ?? DEFAULT_TRUST_SETTINGS.allowedCommands,
      grantHours: intIn(settings.grantHours, 1, 24) ?? DEFAULT_TRUST_SETTINGS.grantHours,
      idleHours: intIn(settings.idleHours, 1, 168) ?? DEFAULT_TRUST_SETTINGS.idleHours,
    },
    paused:
      paused !== null &&
      typeof paused.at === "string" &&
      (paused.reason === "idle" || paused.reason === "stopped")
        ? { at: paused.at, reason: paused.reason }
        : null,
    lastActivityAt: typeof raw.lastActivityAt === "string" ? raw.lastActivityAt : null,
  };
}

/** The same cleaning for what Settings sends. */
export function cleanSettings(next: MyComputerTrustSettings): MyComputerTrustSettings {
  return parseTrustFile(JSON.stringify({ settings: next })).settings;
}

export function makeTrustStore(input: {
  readonly stateDir: string;
  readonly now?: () => Date;
}): TrustStore {
  const dir = path.join(input.stateDir, "my-computer");
  const file = path.join(dir, "trust.json");
  const now = input.now ?? (() => new Date());
  const grants = new Map<string, MyComputerChatGrant>();

  let loaded: Promise<Persisted> | null = null;
  let current: Persisted | null = null;
  let writing: Promise<void> = Promise.resolve();
  /** Saving the clock on every call would write the disk all day: once a minute. */
  let savedActivityAt = 0;

  const load = async (): Promise<Persisted> => {
    if (current !== null) return current;
    loaded ??= fsp
      .readFile(file, "utf8")
      .then(parseTrustFile, () => parseTrustFile(""))
      .then((value) => {
        // A first start counts as activity: no pause for a computer never used.
        current = current ?? {
          ...value,
          lastActivityAt: value.lastActivityAt ?? now().toISOString(),
        };
        return current;
      });
    return loaded;
  };

  const save = (next: Persisted) => {
    current = next;
    const text = `${JSON.stringify(next, null, 2)}\n`;
    const write = async () => {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      const temporary = `${file}.tmp`;
      await fsp.writeFile(temporary, text, { mode: 0o600 });
      await fsp.rename(temporary, file);
    };
    writing = writing.then(write, write);
    return writing;
  };

  const liveGrants = () => {
    const at = now().getTime();
    for (const [key, grant] of grants) {
      if (Date.parse(grant.expiresAt) <= at) grants.delete(key);
    }
    return [...grants.values()];
  };

  const paused = async (): Promise<MyComputerPause | null> => {
    const state = await load();
    if (state.paused !== null) return state.paused;
    const last = state.lastActivityAt === null ? NaN : Date.parse(state.lastActivityAt);
    if (Number.isFinite(last) && now().getTime() - last >= state.settings.idleHours * HOUR_MS) {
      const pause: MyComputerPause = { at: now().toISOString(), reason: "idle" };
      // Idle access goes back to asking: the chats' Allows go too.
      grants.clear();
      await save({ ...state, paused: pause });
      return pause;
    }
    return null;
  };

  return {
    settings: async () => (await load()).settings,
    state: async (running) => {
      const pause = await paused();
      const state = await load();
      return {
        settings: state.settings,
        defaults: DEFAULT_TRUST_SETTINGS,
        grants: liveGrants(),
        paused: pause,
        lastActivityAt: state.lastActivityAt,
        running,
      };
    },
    setSettings: async (next) => {
      const state = await load();
      await save({ ...state, settings: cleanSettings(next) });
    },
    grantActive: (threadId, computerId) => {
      const grant = grants.get(keyOf(threadId, computerId));
      if (grant === undefined) return false;
      if (Date.parse(grant.expiresAt) > now().getTime()) return true;
      grants.delete(keyOf(threadId, computerId));
      return false;
    },
    grant: async ({ threadId, threadTitle, computerId }) => {
      const { settings } = await load();
      const at = now();
      grants.set(keyOf(threadId, computerId), {
        threadId,
        threadTitle,
        computerId,
        grantedAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + settings.grantHours * HOUR_MS).toISOString(),
      });
    },
    revoke: (threadId, computerId) => {
      grants.delete(keyOf(threadId, computerId));
    },
    revokeComputer: (computerId) => {
      for (const [key, grant] of grants) if (grant.computerId === computerId) grants.delete(key);
    },
    paused,
    pause: async (reason) => {
      const state = await load();
      grants.clear();
      await save({ ...state, paused: { at: now().toISOString(), reason } });
    },
    resume: async () => {
      const state = await load();
      savedActivityAt = now().getTime();
      await save({ ...state, paused: null, lastActivityAt: now().toISOString() });
    },
    touch: async () => {
      const state = await load();
      const at = now();
      current = { ...state, lastActivityAt: at.toISOString() };
      if (at.getTime() - savedActivityAt >= 60_000) {
        savedActivityAt = at.getTime();
        await save(current);
      }
    },
  };
}
