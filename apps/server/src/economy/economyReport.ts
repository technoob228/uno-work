/**
 * Economy mode, the daemon's side: what to tell the console about this
 * computer and when (fishcode `POST /api/v1/boxes/{id}/work/activity`).
 *
 * The console decides when an economy computer sleeps. It sees its own
 * signals (Uno Work opening through app.uno4.work, relay messages, Box Run,
 * node CPU), but not what happens inside: a person typing in an open tab, an
 * agent turn waiting on a model, an app that must stay up. The daemon reports
 * exactly that — once a minute, and at once when something changes (a turn
 * starts, the last one ends, the computer just woke up).
 *
 * A Work computer whose daemon never reported is never put to sleep by the
 * console, so an old daemon can't be surprised mid-turn.
 *
 * Kept free of Effect so tests drive it directly.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { UnoComputerEconomy, UnoEconomyPresence } from "@t3tools/contracts";

import { parseComputerEconomy } from "../workspaceRegistry/unoComputerEconomy.ts";

/** How often the probe runs. */
export const ECONOMY_TICK_MS = 10_000;
/** A report at least this often, even when nothing changed. */
export const ECONOMY_REPORT_INTERVAL_MS = 60_000;
/**
 * A tick that comes this much later than planned means the computer was
 * frozen (economy sleep, a memory snapshot): report at once, the console and
 * the clients need to know it is back.
 */
export const ECONOMY_WAKE_GAP_MS = 20_000;
/** Manifest field an app uses to ask to stay awake: `"runs": "always"`. */
export const MANIFEST_RUNS_ALWAYS = "always";

export interface EconomyProbe {
  /** Connected clients (browser tabs, desktop app). */
  readonly clients: number;
  /** Agent turns in progress. */
  readonly runningTurns: number;
  /** Terminals with a live child process. */
  readonly runningTerminals: number;
  /** Explicit reasons to stay awake ("app:<id>"). */
  readonly keepAwake: ReadonlyArray<string>;
  /** Earliest scheduled job (ISO), null — none. */
  readonly nextWakeAt: string | null;
}

export interface EconomyReportBody {
  readonly clients: number;
  readonly last_input_at?: string;
  readonly running_turns: number;
  readonly running_terminals: number;
  readonly keep_awake: ReadonlyArray<string>;
  readonly next_wake_at?: string;
}

export function buildReportBody(
  probe: EconomyProbe,
  lastInputAt: number | null,
): EconomyReportBody {
  return {
    clients: Math.max(0, probe.clients),
    ...(lastInputAt !== null ? { last_input_at: new Date(lastInputAt).toISOString() } : {}),
    running_turns: Math.max(0, probe.runningTurns),
    running_terminals: Math.max(0, probe.runningTerminals),
    keep_awake: probe.keepAwake.slice(0, 16),
    ...(probe.nextWakeAt ? { next_wake_at: probe.nextWakeAt } : {}),
  };
}

/**
 * What changes the console's verdict: busy or not, clients or not, the
 * alarm. Counts inside "busy" do not matter (2 turns vs 3 is the same answer).
 */
export function probeSignature(probe: EconomyProbe): string {
  return [
    probe.runningTurns > 0 ? "turns" : "",
    probe.runningTerminals > 0 ? "terms" : "",
    probe.clients > 0 ? "clients" : "",
    probe.keepAwake.toSorted().join(","),
    probe.nextWakeAt ?? "",
  ].join("|");
}

export interface ReportDecisionInput {
  readonly now: number;
  readonly lastSentAt: number | null;
  readonly lastSignature: string | null;
  readonly signature: string;
  readonly woke: boolean;
  /** The person touched a client since the last report. */
  readonly inputSinceSent: boolean;
  /** The console's last word on when the computer sleeps (ms), null — unknown. */
  readonly sleepAfter: number | null;
}

/** Send a report now? */
export function shouldReport(input: ReportDecisionInput): boolean {
  if (input.lastSentAt === null || input.woke) return true;
  if (input.signature !== input.lastSignature) return true;
  if (input.now - input.lastSentAt >= ECONOMY_REPORT_INTERVAL_MS) return true;
  // The person is here and the console is about to put the computer to
  // sleep: tell it now, not at the next minute.
  return (
    input.inputSinceSent &&
    input.sleepAfter !== null &&
    input.sleepAfter - input.now <= 2 * ECONOMY_TICK_MS
  );
}

/** A tick that came much later than planned: the computer was frozen. */
export function detectWake(
  previousTickAt: number | null,
  now: number,
  tickMs = ECONOMY_TICK_MS,
): boolean {
  return previousTickAt !== null && now - previousTickAt > tickMs + ECONOMY_WAKE_GAP_MS;
}

/** The console's answer to a report, as the presence clients get. */
export function presenceFromConsole(body: unknown, reportedAt: number): UnoEconomyPresence | null {
  const economy: UnoComputerEconomy | null = parseComputerEconomy(body);
  if (!economy) return null;
  return {
    enabled: economy.enabled,
    state: economy.state,
    sleepAfter: economy.sleepAfter,
    idleTimeoutS: economy.idleTimeoutS,
    busy: economy.busy,
    reportedAt: new Date(reportedAt).toISOString(),
  };
}

export const PRESENCE_OFF: UnoEconomyPresence = {
  enabled: false,
  state: "off",
  sleepAfter: null,
  idleTimeoutS: 0,
  busy: [],
  reportedAt: null,
};

/**
 * Apps that asked to stay awake: `~/.uno/apps/<id>.json` with
 * `"runs": "always"` (a bot on long polling, a queue consumer). Everything
 * else is "wake on request" — a web app wakes the computer when it is opened.
 */
export async function readKeepAwakeApps(manifestDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(manifestDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).slice(0, 200)) {
    try {
      const raw = await readFile(path.join(manifestDir, name), "utf8");
      if (raw.length > 32 * 1024) continue;
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      if (record["runs"] !== MANIFEST_RUNS_ALWAYS) continue;
      const id =
        typeof record["id"] === "string" && record["id"] ? record["id"] : name.slice(0, -5);
      out.push(`app:${id}`.slice(0, 64));
    } catch {
      // A broken manifest is the apps screen's problem, not a reason to stay up.
    }
  }
  return out.toSorted();
}

/** Earliest ISO time among candidates that is still in the future. */
export function earliestFuture(times: ReadonlyArray<string>, now: number): string | null {
  let best: number | null = null;
  for (const t of times) {
    const ms = Date.parse(t);
    if (!Number.isFinite(ms) || ms <= now) continue;
    if (best === null || ms < best) best = ms;
  }
  return best === null ? null : new Date(best).toISOString();
}
