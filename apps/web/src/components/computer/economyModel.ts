/**
 * Economy mode — the words and the small decisions around it, React-free so
 * they are tested directly.
 *
 * Economy mode ("runs only when needed"): the computer sleeps when nobody
 * uses it and wakes in about a second when something needs it. The console
 * decides when it sleeps; this side shows it, lets the person switch it, and
 * keeps an idle tab from waking the computer straight back up.
 */
import type { UnoComputerEconomy, UnoEconomyPresence } from "@t3tools/contracts";

export type EconomyChipTone = "awake" | "sleeping" | "waking" | "off";

export interface EconomyChip {
  readonly tone: EconomyChipTone;
  /** "Economy · awake" */
  readonly label: string;
}

export function economyChip(
  economy: Pick<UnoComputerEconomy, "enabled" | "state"> | null | undefined,
): EconomyChip | null {
  if (!economy || !economy.enabled) return null;
  switch (economy.state) {
    case "sleeping":
      return { tone: "sleeping", label: "Economy · sleeping" };
    case "waking":
      return { tone: "waking", label: "Economy · waking" };
    case "stopped":
      return { tone: "off", label: "Economy · off" };
    default:
      return { tone: "awake", label: "Economy · awake" };
  }
}

/** "10 minutes", "1 hour" — the idle timer in words. */
export function idleLabel(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) {
    const h = seconds / 3600;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  const m = Math.max(1, Math.round(seconds / 60));
  return m === 1 ? "1 minute" : `${m} minutes`;
}

/** The idle timers the person can pick. */
export const ECONOMY_IDLE_CHOICES: ReadonlyArray<number> = [300, 600, 1800, 3600, 3 * 3600];

/** The one-paragraph explanation under the switch. */
export function economyDescription(economy: UnoComputerEconomy): string {
  const idle = idleLabel(economy.idleTimeoutS);
  const base =
    `Runs only when needed: after ${idle} with nothing to do, your computer sleeps and you don't pay for it. ` +
    "It wakes in about a second when you open Uno Work, message your assistant in Telegram or Slack, or someone opens one of its apps.";
  if (economy.locked) return `${base} The free computer always works this way.`;
  return base;
}

const WAKE_SOURCE_WORDS: Record<string, string> = {
  work: "you opened Uno Work",
  telegram: "a Telegram message",
  slack: "a Slack message",
  http: "someone opened one of its apps",
  schedule: "a scheduled task",
  run: "a command from the API",
  api: "a wake-up request",
};

/** "Woke up 3 minutes ago — a Telegram message." / "Sleeps in 4 minutes if nothing happens." */
export function economyStatusLine(
  economy: UnoComputerEconomy,
  now: number = Date.now(),
): string | null {
  if (!economy.enabled) return null;
  if (economy.state === "sleeping") {
    return "Asleep. It wakes by itself when something needs it.";
  }
  if (economy.state === "waking") return "Waking up…";
  if (economy.busy.length > 0) {
    return `Staying awake: ${economy.busy.map(busyWords).join(", ")}.`;
  }
  if (economy.sleepAfter) {
    const at = Date.parse(economy.sleepAfter);
    if (Number.isFinite(at)) {
      const seconds = Math.round((at - now) / 1000);
      if (seconds <= 30) return "Going to sleep now — nothing is using it.";
      return `Sleeps in ${idleLabel(seconds)} if nothing happens.`;
    }
  }
  const source = economy.lastWakeSource ? WAKE_SOURCE_WORDS[economy.lastWakeSource] : undefined;
  return source ? `Last woke up because ${source}.` : null;
}

function busyWords(reason: string): string {
  const [kind, value] = reason.split(":", 2);
  switch (kind) {
    case "agent":
      return value === "1" ? "an agent is working" : "agents are working";
    case "clients":
      return "you're using it";
    case "terminal":
      return "a terminal command is running";
    case "run":
      return "a command is running";
    case "app":
      return `${value ?? "an app"} keeps it on`;
    default:
      return "it's busy";
  }
}

/** How long before the planned sleep an idle tab stops trying to reconnect. */
export const ECONOMY_HOLD_LEAD_MS = 15_000;

/**
 * Should this client stop reconnecting on its own (and wait for the person)?
 * Yes when economy is on, the computer is asleep or about to sleep, and the
 * person hasn't touched this client since the idle window started: an open,
 * forgotten tab must not wake the computer back up every minute.
 */
export function shouldHoldReconnect(
  presence: UnoEconomyPresence | null,
  lastInputAt: number | null,
  now: number,
): boolean {
  if (!presence || !presence.enabled) return false;
  if (presence.state === "sleeping") return true;
  if (!presence.sleepAfter || presence.busy.length > 0) return false;
  const sleepAt = Date.parse(presence.sleepAfter);
  if (!Number.isFinite(sleepAt) || now < sleepAt - ECONOMY_HOLD_LEAD_MS) return false;
  // Touched after the idle window started: the person is here, let it reconnect.
  const windowStart = sleepAt - presence.idleTimeoutS * 1000;
  return lastInputAt === null || lastInputAt < windowStart;
}

/** How often a client says "the person is here" (at most). */
export const PRESENCE_INPUT_THROTTLE_MS = 30_000;
/** How often a client refreshes the picture without input. */
export const PRESENCE_POLL_MS = 60_000;
