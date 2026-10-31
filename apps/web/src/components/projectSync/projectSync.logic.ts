/**
 * What a project's sync looks like in the sidebar and in Project settings:
 * one small mark (✓ synced, ↻ syncing, ⚠ needs you) and plain lines. Pure.
 *
 * @module projectSync/projectSync.logic
 */
import type {
  EnvironmentId,
  ProjectSyncArrival,
  ProjectSyncConflict,
  ProjectSyncElsewhere,
  ProjectSyncEntry,
  ProjectSyncHost,
  ProjectSyncSnapshot,
  ProjectSyncState,
  ProjectVersion,
} from "@t3tools/contracts";

export type ProjectSyncMark = "synced" | "syncing" | "conflict" | "held" | "problem" | null;

/**
 * The row's mark: nothing when the project isn't on all computers (or has
 * nothing yet). `held`: files with a key wait here; the rest of it synced.
 */
export function syncMarkOf(
  state: ProjectSyncState | null | undefined,
  held?: ReadonlyArray<string>,
): ProjectSyncMark {
  switch (state) {
    case "synced":
      return (held?.length ?? 0) > 0 ? "held" : "synced";
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
      if ((entry.held?.length ?? 0) > 0) return entry.message;
      return `${whereItLives(entry)}${entry.lastSyncedAt ? ` · synced ${ago(entry.lastSyncedAt, now)}` : ""}.`;
    case "empty":
      return `${whereItLives(entry)}. Nothing to sync yet.`;
    case "conflict":
      return conflictLine(entry);
    default:
      return entry.message || "Couldn't sync.";
  }
}

const whereItLives = (entry: ProjectSyncEntry) =>
  entry.team ? `Shared by ${entry.team.owner}` : "On all your computers";

/** Where else the project lives. Git's words only in Dev Mode. */
export function hostLine(host: ProjectSyncHost, devMode: boolean): string {
  const label = host.provider === "github" ? "GitHub" : "GitLab";
  return devMode
    ? `${host.url} · private · remote ${host.remote} · pushes and pulls by itself`
    : `Also in your ${label} account. Saved versions go there by themselves.`;
}

/** "plan.md changed on both computers. The newer version is here; the other one is kept." */
export function conflictLine(entry: ProjectSyncEntry): string {
  const conflict = entry.conflict;
  if (!conflict) return entry.message;
  const keptOnlyMine = Object.values(conflict.kept).every((side) => side === "mine");
  if (conflict.person) {
    const same =
      conflict.files.length === 1 ? "the same file" : `${conflict.files.length} of the same files`;
    return keptOnlyMine
      ? `${conflict.person} changed ${same}. Yours stays here, and theirs is saved.`
      : `${conflict.person} changed ${same}. Your version is saved.`;
  }
  const what = conflict.files.length === 1 ? conflict.files[0] : `${conflict.files.length} files`;
  const where = conflict.from ? `here and on ${conflict.from}` : "on two computers";
  const keptTheirs = Object.values(conflict.kept).every((side) => side === "theirs");
  const kept = keptOnlyMine
    ? "This computer's version is kept"
    : keptTheirs
      ? `The version from ${conflict.from ?? "the other computer"} is kept`
      : "The newer version of each is kept";
  return `${what} changed ${where}. ${kept}; the other one is in the history.`;
}

/** A file here is someone else's version now: "Bring mine back" has something to bring. */
export function mineWasReplaced(conflict: ProjectSyncConflict | null | undefined): boolean {
  return Object.values(conflict?.kept ?? {}).some((side) => side === "theirs");
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

// ── Versions ────────────────────────────────────────────────────────────

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** The heading a version falls under: "how it was yesterday". */
export function versionDay(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameDay(at, today)) return "Today";
  if (sameDay(at, yesterday)) return "Yesterday";
  return at.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function versionTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** Versions by day, newest first, in the order they came. */
export function groupVersions(
  versions: ReadonlyArray<ProjectVersion>,
  now = Date.now(),
): ReadonlyArray<{ day: string; versions: ReadonlyArray<ProjectVersion> }> {
  const days: Array<{ day: string; versions: ProjectVersion[] }> = [];
  for (const version of versions) {
    const day = versionDay(version.at, now);
    const last = days.at(-1);
    if (last?.day === day) last.versions.push(version);
    else days.push({ day, versions: [version] });
  }
  return days;
}

/** "You on macbook · plan.md", or what the version says about itself. */
export function versionLine(version: ProjectVersion): string {
  const person = version.mine ? "You" : version.person;
  const who =
    person && version.computer
      ? `${person} on ${version.computer}`
      : (person ?? version.computer ?? "Saved");
  const count = version.files.length + version.moreFiles;
  const what = count === 1 ? version.files[0]?.path : `${count} files`;
  return [version.note ?? who, count > 0 ? what : null].filter(Boolean).join(" · ");
}

// ── What travels ────────────────────────────────────────────────────────

export function fileCount(count: number): string {
  return count === 1 ? "1 file" : `${count.toLocaleString("en-US")} files`;
}

/**
 * The Keys row: the project's keys, then key files beyond them. `.env` is
 * where those keys are, not one more.
 */
export function projectKeyCount(keys: number, keyFiles: ReadonlyArray<string>): number {
  return keys + keyFiles.filter((file) => file !== ".env").length;
}

/** "a, b and 4 more": the names in the one question to older projects. */
export function nameList(names: ReadonlyArray<string>, shown = 5): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= shown) {
    return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  }
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
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

/** A shared project arrived. */
export const SHARED_PROJECT_HERE =
  "Your changes and theirs go both ways. Keys you were given are in its .env.";

/** A shared project with nothing in it yet. */
export const sharedWaitingLine = (name: string) =>
  `Nothing is saved in ${name} yet. It comes here once its owner has saved it.`;

/**
 * What the person hears of a shared project coming here. Right after their
 * Accept always something; when it came by itself, only that it's here: its
 * row in the sidebar says the rest.
 */
export function arrivalWords(
  name: string,
  outcome: ProjectSyncArrival["outcome"],
  afterAccept: boolean,
): {
  readonly type: "success" | "info";
  readonly title: string;
  readonly description: string;
} | null {
  if (outcome === "here") {
    return {
      type: "success",
      title: `${name} is on this computer`,
      description: SHARED_PROJECT_HERE,
    };
  }
  if (!afterAccept) return null;
  return {
    type: "info",
    title: `You're in ${name}`,
    description:
      outcome === "waiting"
        ? sharedWaitingLine(name)
        : outcome === "taken"
          ? "Get it here from Projects on your other computers."
          : "Open it from one of your computers to get it there.",
  };
}

/** The accepted projects to bring here, each at most once while this window is open. */
export function arrivalsToBring(
  environmentId: string,
  projects: ReadonlyArray<ProjectSyncElsewhere>,
  tried: ReadonlySet<string>,
): ReadonlyArray<ProjectSyncElsewhere & { readonly tryKey: string }> {
  return projects.flatMap((project) => {
    if (!project.team || project.waiting) return [];
    const tryKey = `${environmentId}:${project.team.id}`;
    return tried.has(tryKey) ? [] : [{ ...project, tryKey }];
  });
}
