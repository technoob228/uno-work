/**
 * What a project's sync looks like in the sidebar and in Project settings:
 * one small mark (✓ synced, ↻ syncing, ⚠ needs you) and plain lines. Pure.
 *
 * @module projectSync/projectSync.logic
 */
import type {
  EnvironmentId,
  ProjectSyncEntry,
  ProjectSyncSnapshot,
  ProjectSyncState,
} from "@t3tools/contracts";

export type ProjectSyncMark = "synced" | "syncing" | "conflict" | "problem" | null;

/** The row's mark: nothing when the project isn't on all computers (or has nothing yet). */
export function syncMarkOf(state: ProjectSyncState | null | undefined): ProjectSyncMark {
  switch (state) {
    case "synced":
      return "synced";
    case "syncing":
      return "syncing";
    case "conflict":
      return "conflict";
    case "too-big":
    case "blocked":
    case "error":
      return "problem";
    default:
      return null;
  }
}

/** The mark's tooltip / the status line in Project settings. */
export function syncLabel(entry: ProjectSyncEntry, now = Date.now()): string {
  switch (entry.state) {
    case "off":
      return "Only on this computer.";
    case "syncing":
      return "Syncing…";
    case "synced":
      return `On all your computers${entry.lastSyncedAt ? ` · synced ${ago(entry.lastSyncedAt, now)}` : ""}.`;
    case "empty":
      return "On all your computers. Nothing to sync yet.";
    case "conflict":
      return conflictLine(entry);
    default:
      return entry.message || "Couldn't sync.";
  }
}

/** "plan.md changed on both computers. The newer version is here; the other one is kept." */
export function conflictLine(entry: ProjectSyncEntry): string {
  const conflict = entry.conflict;
  if (!conflict) return entry.message;
  const what = conflict.files.length === 1 ? conflict.files[0] : `${conflict.files.length} files`;
  const where = conflict.from ? `here and on ${conflict.from}` : "on two computers";
  const keptMine = Object.values(conflict.kept).every((side) => side === "mine");
  const keptTheirs = Object.values(conflict.kept).every((side) => side === "theirs");
  const kept = keptMine
    ? "This computer's version is kept"
    : keptTheirs
      ? `The version from ${conflict.from ?? "the other computer"} is kept`
      : "The newer version of each is kept";
  return `${what} changed ${where}. ${kept}; the other one is in the history.`;
}

function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Entries by `environmentId:projectId`, from each computer's status. */
export function entriesByProject(
  statuses: ReadonlyArray<{
    environmentId: EnvironmentId;
    status: ProjectSyncSnapshot | undefined;
  }>,
): ReadonlyMap<string, ProjectSyncEntry> {
  const out = new Map<string, ProjectSyncEntry>();
  for (const { environmentId, status } of statuses) {
    for (const entry of status?.projects ?? [])
      out.set(`${environmentId}:${entry.projectId}`, entry);
  }
  return out;
}

/** How often to ask again: quickly while something syncs, else now and then. */
export function refreshEveryMs(status: ProjectSyncSnapshot | undefined): number {
  return status?.projects.some((entry) => entry.state === "syncing") ? 2_000 : 30_000;
}

/** The menu item's label: a check when it's on. */
export function toggleMenuLabel(enabled: boolean): string {
  return enabled ? "✓ On all my computers" : "On all my computers";
}
