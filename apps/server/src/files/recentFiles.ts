/**
 * Files → Recent, the pure part: the list of files the person opened (kept
 * in the state dir as `files-recent.json`) and the files agents changed in
 * chats (from the turns' checkpoint summaries), merged into one list —
 * newest first, one row per file.
 *
 * @module files/recentFiles
 */
import nodePath from "node:path";

/** Opened files kept per computer; older ones fall off. */
export const RECENT_OPENED_MAX = 200;

export interface RecentOpened {
  readonly path: string;
  /** ISO time. */
  readonly openedAt: string;
}

export interface RecentAgentChange {
  readonly path: string;
  /** ISO time the agent's turn finished. */
  readonly at: string;
  readonly threadId: string;
  readonly threadTitle: string;
}

export type RecentCandidate =
  | { readonly source: "opened"; readonly path: string; readonly at: string }
  | {
      readonly source: "agent";
      readonly path: string;
      readonly at: string;
      readonly threadId: string;
      readonly threadTitle: string;
    };

/** `path` opened at `at`: moved to the top, never twice, at most `max` kept. */
export function addRecentOpened(
  items: ReadonlyArray<RecentOpened>,
  path: string,
  at: string,
  max = RECENT_OPENED_MAX,
): RecentOpened[] {
  return [{ path, openedAt: at }, ...items.filter((item) => item.path !== path)].slice(0, max);
}

/** The stored file, tolerant of anything malformed (a broken file is an empty list). */
export function parseRecentOpened(raw: unknown): RecentOpened[] {
  const items =
    raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items as unknown[])
      : [];
  const seen = new Set<string>();
  const result: RecentOpened[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const { path, openedAt } = item as { path?: unknown; openedAt?: unknown };
    if (typeof path !== "string" || !path.startsWith("/") || typeof openedAt !== "string") continue;
    if (Number.isNaN(Date.parse(openedAt)) || seen.has(path)) continue;
    seen.add(path);
    result.push({ path, openedAt });
  }
  return result
    .toSorted((left, right) => Date.parse(right.openedAt) - Date.parse(left.openedAt))
    .slice(0, RECENT_OPENED_MAX);
}

export interface RecentTurnRow {
  readonly threadId: string;
  readonly threadTitle: string;
  /** The chat's worktree, when it has one; otherwise the project folder. */
  readonly worktreePath: string | null;
  readonly workspaceRoot: string;
  readonly completedAt: string;
  /** `checkpoint_files_json`: `[{ path, kind, … }]`, paths relative to the chat's folder. */
  readonly filesJson: string;
}

/**
 * The files each finished turn changed, as absolute paths. Paths are
 * relative to the chat's folder (worktree or project); anything that would
 * climb out of it is dropped.
 */
export function agentChangesFromTurns(rows: ReadonlyArray<RecentTurnRow>): RecentAgentChange[] {
  const changes: RecentAgentChange[] = [];
  for (const row of rows) {
    const base = row.worktreePath ?? row.workspaceRoot;
    if (!base || !nodePath.isAbsolute(base)) continue;
    let files: unknown;
    try {
      files = JSON.parse(row.filesJson);
    } catch {
      continue;
    }
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      const relative = (file as { path?: unknown } | null)?.path;
      const kind = (file as { kind?: unknown } | null)?.kind;
      if (typeof relative !== "string" || relative.length === 0 || kind === "deleted") continue;
      const absolute = nodePath.resolve(base, relative);
      if (absolute !== base && !absolute.startsWith(`${base.replace(/\/+$/, "")}/`)) continue;
      changes.push({
        path: absolute,
        at: row.completedAt,
        threadId: row.threadId,
        threadTitle: row.threadTitle,
      });
    }
  }
  return changes;
}

/**
 * Opened and agent-changed files as one list: newest first, one row per
 * file (its latest event wins), at most `limit`.
 */
export function mergeRecentFiles(
  opened: ReadonlyArray<RecentOpened>,
  changes: ReadonlyArray<RecentAgentChange>,
  limit: number,
): RecentCandidate[] {
  const byPath = new Map<string, RecentCandidate>();
  const consider = (candidate: RecentCandidate) => {
    const time = Date.parse(candidate.at);
    if (Number.isNaN(time)) return;
    const existing = byPath.get(candidate.path);
    if (existing && Date.parse(existing.at) >= time) return;
    byPath.set(candidate.path, candidate);
  };
  for (const item of opened) consider({ source: "opened", path: item.path, at: item.openedAt });
  for (const change of changes) consider({ source: "agent", ...change });
  return [...byPath.values()]
    .toSorted((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, Math.max(0, limit));
}
