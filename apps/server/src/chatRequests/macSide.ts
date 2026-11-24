/**
 * "A cloud agent works on my Mac" (`my_computer_*`, T47) under the person's
 * switch there and in a log there (Misha 23.11): on a computer where Uno Work
 * runs, the cloud side
 *
 * - reads its `state.json` (chatRequests/spool.ts) before each call: the
 *   switch in Settings → Computer → Cloud agents is off (the default, or
 *   "Stop cloud agents" pressed) → the call is refused with where to turn it
 *   on; read at most every few seconds per computer;
 * - appends a line to its `commands.jsonl` before the call runs (and when it
 *   is refused), so the person sees every command there, live; a line that
 *   can't be written stops the call (never a command the log there missed).
 *
 * A computer without Uno Work (the helper alone: no `state.json`) works as
 * before: the T47 tiers, the journal in Settings → My computer here.
 *
 * @module chatRequests/macSide
 */
import * as os from "node:os";

import {
  CHAT_REQUESTS_DIR,
  ChatRequestsHostState,
  REMOTE_COMMANDS_FILE,
  type RemoteCommandLine,
} from "@t3tools/contracts";
import { Schema } from "effect";

/** How long one reading of the switch there holds. */
export const MAC_SIDE_STATE_TTL_MS = 2_000;
const SUMMARY_CHARS = 600;

export type MacSideState =
  /** No Uno Work there (the helper alone): as before. */
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly allow: boolean; readonly stoppedAt: string | null };

export interface MacSideIo {
  /** The file there, quietly; null: not there. Throws when it can't be read. */
  readonly read: (computerId: string, path: string) => Promise<string | null>;
  /** Appends to the file there, quietly. */
  readonly append: (computerId: string, path: string, text: string) => Promise<void>;
  readonly nowMs?: () => number;
}

export interface MacSide {
  readonly state: (computerId: string) => Promise<MacSideState>;
  readonly log: (computerId: string, line: RemoteCommandLine) => Promise<void>;
}

const decodeHostState = Schema.decodeUnknownOption(ChatRequestsHostState);
const STATE_PATH = `${CHAT_REQUESTS_DIR}/state.json`;

export const MAC_SIDE_REFUSALS = {
  off: (name: string) =>
    `Cloud agents are off on ${name}: the person keeps them off in Uno Work there (Settings → Computer → Cloud agents). Don't try another way; if it matters, tell them in one line where to turn it on.`,
  stopped: (name: string) =>
    `The person pressed "Stop cloud agents" on ${name}. Nothing runs there until they turn cloud agents on again in Uno Work there (Settings → Computer → Cloud agents). Tell them; don't try another way.`,
  unchecked: (name: string) =>
    `Couldn't check the person's switch for cloud agents on ${name}, so nothing ran. Try again in a moment.`,
  unlogged: (name: string) =>
    `Couldn't write the command into the log on ${name}, so it didn't run (every command of a cloud agent shows there first). Try again in a moment.`,
};

/** What a `state.json` there says; anything unreadable counts as off. */
export function macSideStateOf(text: string | null): MacSideState {
  if (text === null) return { kind: "absent" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "present", allow: false, stoppedAt: null };
  }
  const decoded = decodeHostState(raw);
  if (decoded._tag === "None") return { kind: "present", allow: false, stoppedAt: null };
  return {
    kind: "present",
    allow: decoded.value.allow,
    stoppedAt: decoded.value.stoppedAt ?? null,
  };
}

/** Null: the call may go on; else the agent's sentence. */
export function macSideRefusal(state: MacSideState, computerName: string): string | null {
  if (state.kind === "absent" || state.allow) return null;
  return state.stoppedAt !== null
    ? MAC_SIDE_REFUSALS.stopped(computerName)
    : MAC_SIDE_REFUSALS.off(computerName);
}

export function commandLine(input: {
  readonly kind: string;
  readonly summary: string;
  readonly outcome: "ran" | "allowed" | "refused";
  readonly tier: string;
  readonly reason?: string | undefined;
  readonly threadTitle: string;
  readonly threadId: string;
  readonly at: Date;
  readonly from?: string;
}): RemoteCommandLine {
  const summary =
    input.summary.length > SUMMARY_CHARS
      ? `${input.summary.slice(0, SUMMARY_CHARS - 1)}…`
      : input.summary;
  return {
    at: input.at.toISOString(),
    kind: input.kind,
    summary,
    outcome: input.outcome,
    tier: input.tier,
    ...(input.reason ? { reason: input.reason.slice(0, 300) } : {}),
    computerName: (
      input.from ??
      (os.hostname().replace(/\.local$/, "") || "a cloud computer")
    ).slice(0, 200),
    threadTitle: input.threadTitle.slice(0, 200),
    threadId: input.threadId,
  };
}

export function makeMacSide(io: MacSideIo): MacSide {
  const nowMs = io.nowMs ?? (() => Date.now());
  const cache = new Map<string, { readonly at: number; readonly state: MacSideState }>();
  return {
    state: async (computerId) => {
      const known = cache.get(computerId);
      if (known !== undefined && nowMs() - known.at < MAC_SIDE_STATE_TTL_MS) return known.state;
      const state = macSideStateOf(await io.read(computerId, STATE_PATH));
      cache.set(computerId, { at: nowMs(), state });
      return state;
    },
    log: (computerId, line) =>
      io.append(computerId, REMOTE_COMMANDS_FILE, `${JSON.stringify(line)}\n`),
  };
}
