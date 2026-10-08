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

import { cleanText } from "../machineApps/appManifest.ts";
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
  /**
   * Commands still running: what an agent or a Work terminal started and has
   * not finished (commandScan.ts). The console holds the computer for them.
   */
  readonly runningTerminals: number;
  /** Their names, for "Staying awake: python is still running". */
  readonly commands?: ReadonlyArray<string>;
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
  /** Names of the running commands (at most 5, 32 chars each). */
  readonly commands?: ReadonlyArray<string>;
  readonly keep_awake: ReadonlyArray<string>;
  readonly next_wake_at?: string;
  /**
   * The apps on this computer, for the console's "On this computer" list.
   * Absent = not sent this time (unchanged, or not known yet) — never "none".
   */
  readonly apps?: ReadonlyArray<ReportedApp>;
}

export function buildReportBody(
  probe: EconomyProbe,
  lastInputAt: number | null,
  apps: ReadonlyArray<ReportedApp> | null = null,
): EconomyReportBody {
  return {
    clients: Math.max(0, probe.clients),
    ...(lastInputAt !== null ? { last_input_at: new Date(lastInputAt).toISOString() } : {}),
    running_turns: Math.max(0, probe.runningTurns),
    running_terminals: Math.max(0, probe.runningTerminals),
    ...(probe.commands && probe.commands.length > 0
      ? { commands: probe.commands.slice(0, 5).map((name) => name.slice(0, 32)) }
      : {}),
    keep_awake: probe.keepAwake.slice(0, 16),
    ...(probe.nextWakeAt ? { next_wake_at: probe.nextWakeAt } : {}),
    ...(apps !== null ? { apps: apps.slice(0, REPORT_APPS_MAX) } : {}),
  };
}

// ---- Apps on this computer, for the console ----
//
// The console shows what an agent (or the person) built on the computer:
// apps registered in `~/.uno/apps` and programs the scan found listening on a
// port. Only what a list needs travels — id, name, icon, port, running, kind.
// Never a command, a working directory, env or logs: a command line can hold
// a token. Whether an app is on the internet the console knows itself (its own
// port forwards), so the daemon does not ask.

/** At most this many apps in one report. */
export const REPORT_APPS_MAX = 32;
export const REPORT_APP_ID_MAX = 64;
export const REPORT_APP_NAME_MAX = 64;
export const REPORT_APP_ICON_MAX = 16;
/**
 * An unchanged list is sent again this often, so the console's copy has a
 * fresh "reported at". A changed one goes with the next report (≤ a minute).
 */
export const APPS_RESEND_MS = 10 * 60_000;

export type ReportedAppKind = "web" | "bot" | "service";

export interface ReportedApp {
  /** Manifest id (`notes`) or, for a found program, the scan's key (`docker:wiki`, `port:8080`). */
  readonly id: string;
  readonly name: string;
  /** Emoji or a couple of letters; icon files are not sent. */
  readonly icon?: string;
  readonly port?: number;
  /** `"always"` — the manifest asks to keep the computer awake for it. */
  readonly runs?: "always";
  /** Absent — the scan can't tell (a portless app it didn't start). */
  readonly running?: boolean;
  readonly kind: ReportedAppKind;
  /** Found running on the computer, not registered in `~/.uno/apps`. */
  readonly found?: true;
}

/** What the report needs of a scanned app (`ScannedApp` + the service's `hidden`). */
export interface AppForReport {
  readonly id: string;
  readonly source: "manifest" | "docker" | "systemd" | "port";
  readonly name: string;
  readonly icon: string | null;
  readonly port: number | null;
  readonly status: "running" | "stopped" | "unknown";
  readonly http: boolean;
  readonly canRemove?: boolean;
  readonly hidden?: boolean;
  readonly manifest: { readonly id: string; readonly telegramBot?: unknown } | null;
}

function byId(a: ReportedApp, b: ReportedApp): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function clip(value: string, max: number): string {
  return Array.from(value).slice(0, max).join("");
}

/**
 * The apps list for the console, from the last scan. Registered apps first,
 * then found programs; the person's hidden ones, Uno's own containers and
 * App Store containers (removed from their own cards, listed there) are left out.
 */
export function buildReportedApps(
  apps: ReadonlyArray<AppForReport>,
  keepAwake: ReadonlyArray<string>,
): ReportedApp[] {
  const always = new Set(keepAwake);
  const registered: ReportedApp[] = [];
  const found: ReportedApp[] = [];
  for (const app of apps) {
    if (app.hidden) continue;
    const manifest = app.source === "manifest" ? app.manifest : null;
    if (!manifest && app.source === "docker" && app.canRemove === false) continue;
    const id = clip(manifest ? manifest.id : app.id, REPORT_APP_ID_MAX);
    if (id.length === 0) continue;
    const name = cleanText(app.name, REPORT_APP_NAME_MAX) ?? id;
    const icon = app.icon ? cleanText(app.icon, REPORT_APP_ICON_MAX) : null;
    const port =
      app.port !== null && Number.isInteger(app.port) && app.port > 0 && app.port < 65536
        ? app.port
        : null;
    const kind: ReportedAppKind = manifest?.telegramBot
      ? "bot"
      : port !== null && (app.http || manifest !== null)
        ? "web"
        : "service";
    const entry: ReportedApp = {
      id,
      name,
      ...(icon ? { icon } : {}),
      ...(port !== null ? { port } : {}),
      ...(manifest && always.has(`app:${manifest.id}`.slice(0, 64))
        ? { runs: MANIFEST_RUNS_ALWAYS }
        : {}),
      ...(app.status === "unknown" ? {} : { running: app.status === "running" }),
      kind,
      ...(manifest ? {} : { found: true as const }),
    };
    (manifest ? registered : found).push(entry);
  }
  return [...registered.toSorted(byId), ...found.toSorted(byId)].slice(0, REPORT_APPS_MAX);
}

/** Same list → same string; any field that the console shows changes it. */
export function appsSignature(apps: ReadonlyArray<ReportedApp>): string {
  return JSON.stringify(apps);
}

export interface AppsDecisionInput {
  readonly now: number;
  readonly lastAppsSentAt: number | null;
  readonly lastAppsSignature: string | null;
  readonly signature: string;
}

/** Put the apps list into this report? First time, when it changed, and every APPS_RESEND_MS. */
export function shouldSendApps(input: AppsDecisionInput): boolean {
  if (input.lastAppsSentAt === null || input.lastAppsSignature === null) return true;
  if (input.signature !== input.lastAppsSignature) return true;
  return input.now - input.lastAppsSentAt >= APPS_RESEND_MS;
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

/**
 * Сколько ходов агента идёт сейчас: диалоги со статусом running в проекции,
 * у которых есть живая сессия адаптера.
 */
export function countRunningTurns(
  liveThreadIds: ReadonlyArray<string>,
  runningThreadIds: ReadonlyArray<string>,
): number {
  const live = new Set(liveThreadIds);
  return runningThreadIds.filter((id) => live.has(id)).length;
}
