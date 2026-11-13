/**
 * Trust tiers on the person's own computer, for screens: the journal's
 * labels and results, the pause line, "Stop all agents"'s toast, when the
 * Inbox says agents are working there, and the settings form's lists and
 * hours. Pure, so it can be tested without React.
 *
 * @module components/localComputer/myComputerTrust.logic
 */
import type {
  MyComputerActivityEntry,
  MyComputerPause,
  MyComputerStopAllResult,
  MyComputerTier,
  MyComputerTrustSettings,
  MyComputerTrustState,
} from "@t3tools/contracts";

export const TIER_LABEL: Readonly<Record<MyComputerTier, string>> = {
  free: "Free",
  chat: "Chat Allow",
  ask: "Asked",
  always: "Always asks",
  blocked: "Blocked",
};

export type TierTone = "neutral" | "info" | "warning" | "error";

export const TIER_TONE: Readonly<Record<MyComputerTier, TierTone>> = {
  free: "neutral",
  chat: "info",
  ask: "warning",
  always: "warning",
  blocked: "error",
};

/** `120 ms`, `1.2 s`, `14 s`, `3 min`, `1 h 5 min`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${Math.floor(ms / 100) / 10} s`;
  if (ms < 60_000) return `${Math.floor(ms / 1_000)} s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

type JournalEntry = Pick<
  MyComputerActivityEntry,
  "tier" | "outcome" | "exitCode" | "durationMs" | "reason"
>;

/**
 * How a line ended: `exit 0 · 1.2 s`, `stopped · 3 s`, `refused: <reason>`.
 * Null: nothing to say (a line from an older helper). A line with a tier and
 * no outcome yet is still running.
 */
export function journalResult(entry: JournalEntry): string | null {
  if (entry.outcome === "refused") {
    const reason = entry.reason?.trim();
    return reason ? `refused: ${reason}` : "refused";
  }
  if (entry.outcome === undefined) {
    return entry.tier !== undefined ? "running" : null;
  }
  const parts: string[] = [];
  if (entry.outcome === "stopped") parts.push("stopped");
  else if (entry.exitCode === null) parts.push(entry.outcome === "failed" ? "killed" : "ended");
  else if (entry.exitCode !== undefined) parts.push(`exit ${entry.exitCode}`);
  else if (entry.outcome === "failed") parts.push("failed");
  if (entry.durationMs !== undefined) parts.push(formatDuration(entry.durationMs));
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The line under a journal entry: the chat, then how it ended. */
export function journalMeta(
  entry: JournalEntry & Pick<MyComputerActivityEntry, "threadTitle">,
  withChat = true,
): string | null {
  const chat = withChat ? entry.threadTitle?.trim() || null : null;
  const parts = [chat, journalResult(entry)].filter(
    (part): part is string => part !== null && part !== "",
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Why agents are paused, in one line. */
export function pauseLine(pause: Pick<MyComputerPause, "reason">, idleHours: number): string {
  return pause.reason === "stopped" ? "You stopped them." : `No agent activity for ${idleHours} h.`;
}

/** Agents count as working there for this long after their last call. */
export const RECENT_ACTIVITY_MS = 10 * 60_000;

/** The Inbox's banner: something runs now, or ran in the last 10 minutes. */
export function agentsActive(
  trust: Pick<MyComputerTrustState, "running" | "lastActivityAt" | "paused">,
  nowMs: number,
): boolean {
  if (trust.running > 0) return true;
  if (trust.paused !== null || trust.lastActivityAt === null) return false;
  const at = Date.parse(trust.lastActivityAt);
  if (Number.isNaN(at)) return false;
  return nowMs - at <= RECENT_ACTIVITY_MS;
}

/** One computer by its name; otherwise what the person calls them. */
export function computersLabel(computers: ReadonlyArray<{ readonly name: string }>): string {
  const [only] = computers;
  if (computers.length === 1 && only !== undefined && only.name.trim() !== "") return only.name;
  return computers.length > 1 ? "your computers" : "your computer";
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "Stop all agents"'s answer as a toast. */
export function stopAllToast(result: MyComputerStopAllResult): {
  type: "success" | "warning";
  title: string;
  description: string;
} {
  const lines: string[] = [
    result.stopped > 0
      ? `Stopped ${plural(result.stopped, "call", "calls")}.`
      : "Nothing was running.",
  ];
  if (result.disconnected.length > 0) {
    lines.push(`Disconnected ${result.disconnected.join(", ")}.`);
  }
  if (result.failed.length > 0) {
    lines.push(
      `Couldn’t disconnect ${result.failed.join(", ")}. Agents stay paused there until you resume.`,
    );
  }
  return {
    type: result.failed.length > 0 ? "warning" : "success",
    title: "Agents stopped",
    description: lines.join(" "),
  };
}

/** "until 14:30" today, "until Nov 14, 09:00" later. */
export function grantUntilLabel(
  expiresAt: string,
  nowMs: number,
  formatTime: (iso: string) => string,
): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date(nowMs).toDateString();
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return sameDay ? `until ${formatTime(expiresAt)}` : `until ${day}, ${formatTime(expiresAt)}`;
}

// ── The settings form ───────────────────────────────────────────────────

/** A new list entry, trimmed; null when it's empty or already there. */
export function addToList(list: ReadonlyArray<string>, value: string): string[] | null {
  const next = value.trim();
  if (next === "" || list.includes(next)) return null;
  return [...list, next];
}

export const GRANT_HOURS = { min: 1, max: 24 } as const;
export const IDLE_HOURS = { min: 1, max: 168 } as const;

/** What was typed as whole hours within bounds; null when it isn't a number. */
export function parseHours(
  text: string,
  bounds: { readonly min: number; readonly max: number },
): number | null {
  const value = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(value)) return null;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

export function sameList(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function sameTrustSettings(a: MyComputerTrustSettings, b: MyComputerTrustSettings): boolean {
  return (
    sameList(a.allowedFolders, b.allowedFolders) &&
    sameList(a.allowedCommands, b.allowedCommands) &&
    a.grantHours === b.grantHours &&
    a.idleHours === b.idleHours
  );
}
