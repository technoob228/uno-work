/**
 * Pure logic of the access journal (Settings → Security → "Who got in"):
 * wire types of the console API, filters, grouping by day and the plain-words
 * labels. No React here — covered by accessJournal.logic.test.ts.
 */

export type AccessChannel =
  | "work"
  | "ssh"
  | "command"
  | "cron"
  | "app"
  | "system"
  | "support"
  | "maintenance";
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
  /**
   * Verdict for rows where Uno's people or key touched the computer
   * (actor uno_staff). Older consoles don't send it — see accessStatus().
   */
  readonly status?: AccessStatus | string;
  /** Why Uno accessed the computer, in plain words. */
  readonly reason?: string;
  /** Which Uno tool or person (e.g. ops:guest-agent-rollout). Not shown. */
  readonly initiator?: string;
  /** Maintenance window (MW-…) or support request (A-…). */
  readonly ref?: string;
  /** On an explanation row: ids of the rows it explains. */
  readonly explains?: ReadonlyArray<number>;
  /** Explanation Uno appended to this row later (rows are never edited). */
  readonly explanation?: {
    readonly id: number;
    readonly at: string;
    readonly reason: string;
    readonly ref?: string;
  };
}

/**
 * - maintenance: Uno maintenance with a record (or explained later);
 * - maintenance_stated: no record, but Uno's tool said why;
 * - unaccounted: no record, no reason — Uno owes an explanation within 24 h.
 */
export type AccessStatus = "maintenance" | "maintenance_stated" | "unaccounted";

export interface AccessSummary {
  readonly total: number;
  readonly you: number;
  readonly agents: number;
  readonly uno_auto: number;
  readonly uno_unexplained: number;
  /** Uno maintenance rows (recorded, explained or with a stated reason). Newer consoles only. */
  readonly uno_maintenance?: number;
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
  readonly uno_maintenance_30d?: number;
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

/** Verdict of a row, or null for ordinary rows (you, agents, automation, others). */
export function accessStatus(entry: AccessEntry): AccessStatus | null {
  if (entry.actor !== "uno_staff") return null;
  if (
    entry.status === "maintenance" ||
    entry.status === "maintenance_stated" ||
    entry.status === "unaccounted"
  ) {
    return entry.status;
  }
  // Older console: no status field.
  if (entry.explanation) return "maintenance";
  if (entry.explained === true) return "maintenance";
  if (entry.reason) return "maintenance_stated";
  return "unaccounted";
}

/** Uno used its key and nobody can say why yet — shown in red. */
export function isUnexplained(entry: AccessEntry): boolean {
  return accessStatus(entry) === "unaccounted";
}

/** Uno maintenance with a reason — shown in amber. */
export function isMaintenance(entry: AccessEntry): boolean {
  const s = accessStatus(entry);
  return s === "maintenance" || s === "maintenance_stated";
}

/** The reason the customer reads: the appended explanation wins over the row's own. */
export function maintenanceReason(entry: AccessEntry): string | null {
  return entry.explanation?.reason || entry.reason || null;
}

export const UNACCOUNTED_TITLE = "Uno used its key without a record";
export const UNACCOUNTED_NOTE = "We'll explain this here within 24 hours.";

/**
 * Plain words for one row: the title and the line under it. Uno's rows get
 * their wording from the verdict, not from the stored label, so old rows read
 * the same way as new ones.
 */
export function entryText(entry: AccessEntry): {
  readonly title: string;
  readonly note: string | null;
} {
  const status = accessStatus(entry);
  if (status === "unaccounted") {
    return { title: UNACCOUNTED_TITLE, note: UNACCOUNTED_NOTE };
  }
  if (status === "maintenance" || status === "maintenance_stated") {
    const reason = maintenanceReason(entry);
    const title = reason ? `Uno maintenance: ${reason}` : "Uno maintenance";
    if (entry.explains && entry.explains.length > 0) {
      const n = entry.explains.length;
      return {
        title,
        note: `Explains ${n} earlier entr${n === 1 ? "y" : "ies"} that had no record.`,
      };
    }
    if (entry.explanation) {
      return { title, note: "Uno added this explanation later. The entry itself is unchanged." };
    }
    if (status === "maintenance_stated") {
      return {
        title,
        note: "Reason given by Uno's maintenance tool. We're matching it to our records.",
      };
    }
    return { title, note: entry.ref ? `Reference ${entry.ref}` : null };
  }
  return { title: entry.who, note: entry.detail || null };
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
    case "maintenance":
      return "Uno maintenance";
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

// ---- bursts: one maintenance run = one line ----

/** A run of Uno's commands with the same verdict and reason, a few minutes apart. */
export interface AccessBurst {
  readonly kind: "burst";
  readonly key: string;
  /** Newest first, like the journal. */
  readonly entries: ReadonlyArray<AccessEntry>;
}

export type AccessItem = { readonly kind: "entry"; readonly entry: AccessEntry } | AccessBurst;

const BURST_GAP_MS = 10 * 60_000;
const BURST_MIN = 3;

function burstKey(entry: AccessEntry): string | null {
  const status = accessStatus(entry);
  if (!status || (entry.explains && entry.explains.length > 0)) return null;
  const tone = status === "unaccounted" ? "red" : "amber";
  return `${tone}|${maintenanceReason(entry) ?? ""}|${entry.explanation?.id ?? ""}`;
}

/**
 * Collapses runs of ≥3 Uno rows with the same verdict and reason (each within
 * 10 minutes of the next) into one line — 46 commands of one maintenance run
 * read as one event, not 46 alarms. Other rows pass through unchanged.
 */
export function collapseBursts(entries: ReadonlyArray<AccessEntry>): AccessItem[] {
  const out: AccessItem[] = [];
  let run: AccessEntry[] = [];
  let runKey: string | null = null;
  const flush = () => {
    if (run.length >= BURST_MIN && runKey) {
      out.push({ kind: "burst", key: `burst-${run[0]!.id}`, entries: run });
    } else {
      for (const entry of run) out.push({ kind: "entry", entry });
    }
    run = [];
    runKey = null;
  };
  for (const entry of entries) {
    const key = burstKey(entry);
    const prev = run[run.length - 1];
    const close =
      prev !== undefined &&
      Math.abs(new Date(prev.at).getTime() - new Date(entry.at).getTime()) <= BURST_GAP_MS;
    if (key && key === runKey && close) {
      run.push(entry);
      continue;
    }
    flush();
    if (key) {
      run = [entry];
      runKey = key;
    } else {
      out.push({ kind: "entry", entry });
    }
  }
  flush();
  return out;
}

/** "46 commands · 22:16–22:17". */
export function burstLabel(burst: AccessBurst): string {
  const n = burst.entries.length;
  const newest = burst.entries[0]!;
  const oldest = burst.entries[n - 1]!;
  const from = formatClock(oldest.at);
  const to = formatClock(newest.at);
  return `${n} commands · ${from === to ? from : `${from}–${to}`}`;
}

// ---- verdict and notes ----

export interface Verdict {
  readonly tone: "good" | "notice" | "bad";
  readonly title: string;
  readonly description: string;
}

/** Uno's access policy, said once wherever maintenance shows up. */
export const UNO_ACCESS_POLICY =
  "Uno can do maintenance on your computers without asking first, and always tells you right away — with the reason.";

export function verdictFor(summary: AccessSummary, days = 30): Verdict {
  const n = summary.uno_unexplained;
  const m = summary.uno_maintenance ?? 0;
  if (n > 0) {
    return {
      tone: "bad",
      title: `Uno used its key ${n} time${n === 1 ? "" : "s"} without a record`,
      description:
        "We're looking into it and will explain each one here within 24 hours. Nothing to do on your side.",
    };
  }
  if (m > 0) {
    return {
      tone: "notice",
      title: `Uno did maintenance on this computer (${m} entr${m === 1 ? "y" : "ies"})`,
      description: `The reason is on each entry below. ${UNO_ACCESS_POLICY}`,
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
  readonly tone: "good" | "notice" | "bad";
  readonly text: string;
} {
  const n = computer.uno_unexplained_30d;
  if (n > 0) return { tone: "bad", text: `Uno without a record: ${n} — we'll explain` };
  if ((computer.uno_maintenance_30d ?? 0) > 0)
    return { tone: "notice", text: "Uno maintenance — see why" };
  return { tone: "good", text: "No unexplained Uno logins (30 days)" };
}
