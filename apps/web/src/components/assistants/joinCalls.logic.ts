/**
 * "Join my calls" in words (pure): when the next call is, what the bot is
 * doing, why it won't go to a meeting.
 */
import type { AssistantCallsView, CallItem } from "../../lib/assistantCallsApi";

const DAY_MS = 24 * 3600_000;

function dayStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "14:00" today, "tomorrow 09:30", "Thu 14:00" this week, else "Nov 3, 14:00" (the person's clock). */
export function callTimeLabel(iso: string, nowMs: number, locale?: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const time = new Date(ms).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((dayStart(ms) - dayStart(nowMs)) / DAY_MS);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  if (days > 1 && days < 7) {
    return `${new Date(ms).toLocaleDateString(locale, { weekday: "short" })} ${time}`;
  }
  return `${new Date(ms).toLocaleDateString(locale, { month: "short", day: "numeric" })}, ${time}`;
}

/** The one line under the switch. */
export function nextCallLine(view: AssistantCallsView, nowMs: number, locale?: string): string {
  const next = view.next;
  if (!next) return "No calls with a link coming up.";
  const status = next.session?.status ?? "";
  if (status === "recording") return `In ${next.title || "the call"} now, taking notes`;
  if (status === "lobby") return `Waiting to be let into ${next.title || "the call"}`;
  if (status === "joining" || status === "queued") return `Joining ${next.title || "the call"} now`;
  const at = callTimeLabel(next.start, nowMs, locale);
  return Date.parse(next.start) <= nowMs
    ? `Joining ${next.title || "the call"} now`
    : `Joining ${next.title || "the call"} at ${at}`;
}

/** Why the bot won't go, in the person's words. */
export function whyNotLabel(call: CallItem): string {
  if (call.join) return "";
  switch (call.why) {
    case "you turned it off":
      return "you turned it off";
    case "you declined":
      return "you declined";
    case "nobody else is invited":
      return "only you are invited";
    case "you're not in this meeting":
      return "you're not invited";
    case "no call link":
      return "no call link";
    case "cancelled":
      return "cancelled";
    default:
      return call.why;
  }
}

export type JoinCallsStage = "off" | "on" | "reconnect" | "setting-up";

export function joinCallsStage(
  view: AssistantCallsView | undefined,
  projectId: string,
): JoinCallsStage {
  if (!view || !view.enabled || view.projectId !== projectId) return "off";
  if (view.google?.needsReconnect || view.google?.connected === false) return "reconnect";
  // The notetaker already reported (calls coming up / a status): it runs, whatever
  // a store reinstall says.
  const heard = view.upcomingAt !== null || view.recent.length > 0;
  if (view.notetaker.state === "installing" && !heard) return "setting-up";
  return "on";
}

/** Another assistant has it on: one bot per computer. */
export function otherAssistantName(
  view: AssistantCallsView | undefined,
  projectId: string,
): string | null {
  return view?.enabled && view.projectId && view.projectId !== projectId
    ? view.assistantName || "another assistant"
    : null;
}
