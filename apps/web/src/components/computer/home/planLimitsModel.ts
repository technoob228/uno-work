/**
 * The "AI plan limits" widget's words: how much of the person's own Claude
 * and ChatGPT plan is used on this computer (the daemon reads it with Claude
 * Code's and Codex's sign-ins — `uno.computer.planLimits`).
 *
 * Plain words for people who aren't developers: "5-hour limit", "Weekly
 * limit", "Resets in 3 h 20 min", and why numbers are old when they are.
 */
import type { PlanLimitsAccount, PlanLimitsWindow } from "@t3tools/contracts";

import { shortAgo } from "./homeModel";

const PROVIDER_NAME: Record<PlanLimitsAccount["provider"], string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
};

/** The agent that renews the sign-in when it runs. */
const AGENT_NAME: Record<PlanLimitsAccount["provider"], string> = {
  claude: "Claude",
  chatgpt: "Codex",
};

/** "Claude Max 20x", "ChatGPT Plus", "Claude". */
export function planAccountTitle(account: PlanLimitsAccount): string {
  const name = PROVIDER_NAME[account.provider];
  return account.plan ? `${name} ${account.plan}` : name;
}

function hoursWord(mins: number | undefined): string {
  if (mins === undefined || mins <= 0 || mins % 60 !== 0) return "Short";
  return `${mins / 60}-hour`;
}

/** "5-hour limit", "Weekly limit", "Weekly · Opus", "Extra usage this month". */
export function planWindowTitle(window: PlanLimitsWindow): string {
  if (window.id === "monthly_spend") return "Extra usage this month";
  const kind =
    window.kind === "session"
      ? hoursWord(window.windowDurationMins)
      : window.kind === "weekly"
        ? "Weekly"
        : window.kind === "monthly"
          ? "Monthly"
          : null;
  if (kind === null) return window.label;
  return window.scope ? `${kind} · ${window.scope}` : `${kind} limit`;
}

/** Whole percent, never "100%" until it really is. */
export function planUsedPercent(window: PlanLimitsWindow): number {
  const value = Math.max(0, Math.min(100, window.usedPercent));
  return value >= 100 ? 100 : Math.min(99, Math.round(value));
}

export type PlanUsageTone = "ok" | "high" | "full";

export function planUsageTone(window: PlanLimitsWindow): PlanUsageTone {
  if (window.usedPercent >= 90) return "full";
  if (window.usedPercent >= 70) return "high";
  return "ok";
}

/**
 * "Resets in 45 min", "Resets in 3 h 20 min", "Resets Fri 6:00 PM", or —
 * for old numbers whose window already ended — "Reset since". Null without
 * a reset time.
 */
export function planResetText(
  resetsAt: string | undefined,
  now: number,
  format: { readonly locale?: string; readonly timeZone?: string } = {},
): string | null {
  const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes <= 0) return "Reset since";
  if (minutes < 60) return `Resets in ${minutes} min`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest > 0 ? `Resets in ${hours} h ${rest} min` : `Resets in ${hours} h`;
  }
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    ...(format.timeZone ? { timeZone: format.timeZone } : {}),
  };
  const day =
    minutes < 6 * 24 * 60
      ? new Intl.DateTimeFormat(format.locale, { ...options, weekday: "short" })
      : new Intl.DateTimeFormat(format.locale, { ...options, month: "short", day: "numeric" });
  return `Resets ${day.format(at)}`;
}

/** "Numbers from 3 h ago" — for numbers that aren't from the latest read. */
export function planStaleText(account: PlanLimitsAccount, now: number): string | null {
  if (!account.stale || !account.checkedAt) return null;
  const ago = shortAgo(Date.parse(account.checkedAt), now);
  if (!ago || ago === "now") return "Numbers from a moment ago";
  return ago === "yesterday" ? "Numbers from yesterday" : `Numbers from ${ago} ago`;
}

/**
 * Why there are no fresh numbers, said for what the person can do about it.
 * With old numbers on screen it follows "Numbers from 3 h ago". Null when
 * the latest read went fine.
 */
export function planProblemText(account: PlanLimitsAccount): string | null {
  const name = PROVIDER_NAME[account.provider];
  const known = account.windows.length > 0;
  switch (account.problem) {
    case undefined:
      return null;
    case "expired":
      return known
        ? `They update the next time you chat with ${AGENT_NAME[account.provider]} here.`
        : `Limits show after your next chat with ${AGENT_NAME[account.provider]} here.`;
    case "rejected":
      return `${name} didn't accept this computer's sign-in. Sign in again in Settings → Agents.`;
    case "busy":
      return `${name} asked to wait. Trying again in a few minutes.`;
    case "locked":
      return "Your Mac didn't share the Claude sign-in with Uno Work. Restart Uno Work to be asked again.";
    case "unreachable":
    case "unexpected":
      return known ? "Couldn't read new ones just now." : "Couldn't read limits just now.";
  }
}

/** Nothing to show for this account: a read that went fine without any limit. */
export function planHasNoLimits(account: PlanLimitsAccount): boolean {
  return account.windows.length === 0 && account.problem === undefined;
}
