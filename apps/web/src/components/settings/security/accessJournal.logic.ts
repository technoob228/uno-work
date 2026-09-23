/**
 * Pure logic of the access journal (Settings → Security → "Who got in"):
 * wire types of the console API, filters, grouping by day and the plain-words
 * labels. No React here — covered by accessJournal.logic.test.ts.
 */

export type AccessChannel = "work" | "ssh" | "command" | "cron" | "app" | "system" | "support";
export type AccessActor = "owner" | "shared" | "agent" | "uno_auto" | "uno_staff" | "other";

/** One row of GET /api/v1/boxes/{id}/security/access-log. */
export interface AccessEntry {
  readonly id: number;
  readonly box_id: number;
  readonly at: string;
  readonly channel: AccessChannel | string;
  readonly actor: AccessActor | string;
  readonly who: string;
  readonly from_ip?: string;
  readonly client?: string;
  readonly detail?: string;
  readonly explained?: boolean;
}

export interface AccessSummary {
  readonly total: number;
  readonly you: number;
  readonly agents: number;
  readonly uno_auto: number;
  readonly uno_unexplained: number;
  readonly ssh_others: number;
  readonly failed_ssh_attempts: number;
  readonly failed_ssh_sources: number;
}

export type GuestScanStatus = "ok" | "asleep" | "unavailable" | "failed" | "throttled";

export interface AccessLogResponse {
  readonly box_id: number;
  readonly since: string;
  readonly entries: ReadonlyArray<AccessEntry>;
  readonly summary: AccessSummary;
  readonly guest_scan: { readonly status: GuestScanStatus | string; readonly at: string | null };
}

/** One row of GET /api/v1/security/summary. */
export interface SecurityComputer {
  readonly box_id: number;
  readonly name: string;
  readonly status: string;
  readonly last_access: {
    readonly at: string;
    readonly who: string;
    readonly channel: string;
  } | null;
  readonly entries_30d: number;
  readonly uno_unexplained_30d: number;
}

export interface SecuritySummaryResponse {
  readonly computers: ReadonlyArray<SecurityComputer>;
}

export const accessLogPath = (boxId: number, days = 30) =>
  `/api/v1/boxes/${boxId}/security/access-log?days=${days}`;
export const securitySummaryPath = "/api/v1/security/summary";

// ---- filters ----

export type AccessFilter = "all" | "you" | "agents" | "uno" | "ssh";

export const ACCESS_FILTERS: ReadonlyArray<{ readonly id: AccessFilter; readonly label: string }> =
  [
    { id: "all", label: "All" },
    { id: "you", label: "You" },
    { id: "agents", label: "AI agents" },
    { id: "uno", label: "Uno" },
    { id: "ssh", label: "SSH" },
  ];

export function isUnoActor(actor: string): boolean {
  return actor === "uno_auto" || actor === "uno_staff";
}

/** A login with Uno's key that has no matching Uno record — shown in red. */
export function isUnexplained(entry: AccessEntry): boolean {
  return entry.actor === "uno_staff" && entry.explained !== true;
}

export function matchesFilter(entry: AccessEntry, filter: AccessFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "you":
      return entry.actor === "owner" || entry.actor === "shared";
    case "agents":
      return entry.actor === "agent";
    case "uno":
      return isUnoActor(entry.actor) || entry.channel === "support";
    case "ssh":
      return entry.channel === "ssh";
  }
}

// ---- labels ----

/** How someone got in, in plain words. */
export function channelLabel(entry: Pick<AccessEntry, "channel" | "client">): string {
  switch (entry.channel) {
    case "work":
      return entry.client === "Uno Work in the browser"
        ? "Uno Work in the browser"
        : "Uno Work app";
    case "ssh":
      return "SSH";
    case "command":
      return "Command";
    case "cron":
      return "Scheduled task";
    case "app":
      return "App install";
    case "system":
      return "Uno automation";
    case "support":
      return "Uno support";
    default:
      return String(entry.channel);
  }
}

// ---- time ----

const pad = (n: number) => String(n).padStart(2, "0");

/** Local "14:05". */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Today", "Yesterday" or "Mon, Sep 21" (local time). */
export function dayLabel(iso: string, now: number): string {
  const d = new Date(iso);
  const today = new Date(now);
  if (dayKey(d) === dayKey(today)) return "Today";
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(d) === dayKey(yesterday)) return "Yesterday";
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

const agoLabel = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function relativeTime(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "unknown";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return agoLabel(Math.round(s / 60), "minute");
  if (s < 86_400) return agoLabel(Math.round(s / 3600), "hour");
  return agoLabel(Math.round(s / 86_400), "day");
}

// ---- grouping ----

export interface AccessDay {
  readonly key: string;
  readonly label: string;
  /** Rows shown by default: people, agents, SSH, and anything unexplained. */
  readonly visible: ReadonlyArray<AccessEntry>;
  /** Uno's automatic operations — collapsed into "N automatic operations by Uno". */
  readonly automatic: ReadonlyArray<AccessEntry>;
}

/** Entries (newest first) grouped by local day, automation split out. */
export function groupByDay(entries: ReadonlyArray<AccessEntry>, now: number): AccessDay[] {
  const days: { key: string; label: string; visible: AccessEntry[]; automatic: AccessEntry[] }[] =
    [];
  for (const entry of entries) {
    const d = new Date(entry.at);
    if (!Number.isFinite(d.getTime())) continue;
    const key = dayKey(d);
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      day = days.find((x) => x.key === key);
      if (!day) {
        day = { key, label: dayLabel(entry.at, now), visible: [], automatic: [] };
        days.push(day);
      }
    }
    if (entry.actor === "uno_auto") day.automatic.push(entry);
    else day.visible.push(entry);
  }
  return days;
}

export function automaticLabel(n: number): string {
  return `${n} automatic operation${n === 1 ? "" : "s"} by Uno`;
}

// ---- verdict and notes ----

export interface Verdict {
  readonly tone: "good" | "bad";
  readonly title: string;
  readonly description: string;
}

export function verdictFor(summary: AccessSummary, days = 30): Verdict {
  const n = summary.uno_unexplained;
  if (n > 0) {
    return {
      tone: "bad",
      title: `${n} login${n === 1 ? "" : "s"} with Uno's key ${n === 1 ? "has" : "have"} no matching record`,
      description: "Contact support — we'll explain each one.",
    };
  }
  return {
    tone: "good",
    title: `No unexplained logins with Uno's key in the last ${days} days.`,
    description:
      "Every time Uno's key signed in to this computer, it matches an operation listed below. Any access, including ours, is visible to you.",
  };
}

export function failedAttemptsLine(summary: AccessSummary): string | null {
  const n = summary.failed_ssh_attempts;
  if (n <= 0) return null;
  const m = summary.failed_ssh_sources;
  return `${n} failed SSH attempt${n === 1 ? "" : "s"} from ${m} address${m === 1 ? "" : "es"} (bots scanning the internet — they didn't get in)`;
}

export function scanNote(status: string): string | null {
  switch (status) {
    case "asleep":
      return "The computer is asleep — SSH logins will be read from it when it wakes up.";
    case "unavailable":
      return "SSH logins can't be read from this computer, so only Uno's own records are listed.";
    case "failed":
      return "Couldn't read the computer's login history just now — showing what's already known. Try Refresh in a minute.";
    default:
      return null;
  }
}

/** Overview line: "Last access: 5 minutes ago — You". */
export function lastAccessLine(computer: SecurityComputer, now: number): string {
  if (!computer.last_access) return "No access recorded yet";
  return `Last access: ${relativeTime(computer.last_access.at, now)} — ${computer.last_access.who}`;
}

export function overviewBadge(computer: SecurityComputer): {
  readonly tone: "good" | "bad";
  readonly text: string;
} {
  const n = computer.uno_unexplained_30d;
  if (n > 0) return { tone: "bad", text: `${n} Uno login${n === 1 ? "" : "s"} without a record` };
  return { tone: "good", text: "No unexplained Uno logins (30 days)" };
}
