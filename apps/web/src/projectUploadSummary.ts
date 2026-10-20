/**
 * What a folder upload leaves out, in words a person can act on: the heavy
 * folders skipped on purpose (node_modules, .git, Python environments…), files
 * over the size cap, and — the dangerous part — files cut by the browser
 * upload limits. Nothing here is silent: the dialog shows all of it before the
 * upload, and the cut files are listed in the project for the agent.
 *
 * Pure: no DOM, no I/O except reading the few tiny `.git` files a worktree
 * check needs (`findSkipSuggestions`).
 */
import type { UploadPlan } from "./firstProject";
import {
  PROJECT_UPLOAD_MAX_FILE_COUNT,
  PROJECT_UPLOAD_MAX_TOTAL_BYTES,
  formatUploadBytes,
} from "./projectUpload";

export interface SkippedGroup {
  /** "node_modules", "Python environments", ".git"… */
  readonly label: string;
  /** Files in it; null when the folder was never opened (skipped while reading). */
  readonly files: number | null;
}

export interface UploadPlanSummary {
  /** Heavy folders left out on purpose, biggest first. */
  readonly skippedGroups: ReadonlyArray<SkippedGroup>;
  readonly skippedFiles: number;
  /** Files over the per-file cap. */
  readonly tooLarge: ReadonlyArray<string>;
  /** Files the limits cut: they would NOT reach the computer. */
  readonly leftOut: ReadonlyArray<string>;
  /** Which limit cut them first. */
  readonly leftOutBy: "files" | "bytes" | null;
  /** Everything that would go if there were no limits. */
  readonly wantedFiles: number;
}

/**
 * Folders skipped without opening them (the folder reader never walks into
 * node_modules) come in as labels with no count.
 */
export function summarizeUploadPlan(
  plan: UploadPlan,
  unopenedFolders: ReadonlyArray<string> = [],
): UploadPlanSummary {
  const groups = new Map<string, number | null>();
  let skippedFiles = 0;
  const tooLarge: string[] = [];
  const leftOut: string[] = [];
  let leftOutBy: UploadPlanSummary["leftOutBy"] = null;
  for (const entry of plan.skipped) {
    if (entry.reason === "ignored") {
      const label = entry.folder ?? "system files";
      groups.set(label, (groups.get(label) ?? 0) + 1);
      skippedFiles += 1;
    } else if (entry.reason === "too-large") {
      tooLarge.push(entry.relativePath);
    } else if (entry.reason === "over-budget") {
      leftOut.push(entry.relativePath);
      leftOutBy ??= entry.limit ?? "files";
    }
  }
  for (const label of unopenedFolders) {
    if (!groups.has(label)) groups.set(label, null);
  }
  const skippedGroups = [...groups.entries()]
    .map(([label, files]) => ({ label, files }))
    .toSorted((a, b) => (b.files ?? Infinity) - (a.files ?? Infinity));
  return {
    skippedGroups,
    skippedFiles,
    tooLarge,
    leftOut,
    leftOutBy,
    wantedFiles: plan.accepted.length + leftOut.length,
  };
}

/** "node_modules, .git, Python environments and 3 more". */
export function skippedGroupsLine(groups: ReadonlyArray<SkippedGroup>, shown = 3): string {
  const names = groups.map((group) => group.label);
  if (names.length <= shown + 1) return joinWords(names);
  return `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`;
}

function joinWords(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "Up to 20,000 files" / "Up to 2 GB" — the limit that cut, in plain words. */
export function uploadLimitLine(by: "files" | "bytes"): string {
  return by === "files"
    ? `up to ${PROJECT_UPLOAD_MAX_FILE_COUNT.toLocaleString("en-US")} files`
    : `up to ${formatUploadBytes(PROJECT_UPLOAD_MAX_TOTAL_BYTES)}`;
}

/**
 * The biggest top folders among the cut files (two levels deep): where to look
 * when picking a smaller folder or what to tick under "Also skip".
 */
export function leftOutHotspots(
  leftOut: ReadonlyArray<string>,
  limit = 3,
): ReadonlyArray<{ readonly folder: string; readonly files: number }> {
  const counts = new Map<string, number>();
  for (const path of leftOut) {
    const segments = path.split("/");
    const folder = segments.length > 2 ? segments.slice(0, 2).join("/") : (segments[0] ?? path);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([folder, files]) => ({ folder, files }))
    .toSorted((a, b) => b.files - a.files)
    .slice(0, limit);
}

/** The list the agent finds in the project: what didn't come and why. */
export const LEFT_OUT_LIST_FILE = ".uno-not-uploaded.txt";

export function leftOutListText(input: {
  readonly summary: UploadPlanSummary;
  readonly folderName: string;
}): string {
  const { summary } = input;
  const lines = [
    `Files of "${input.folderName}" that were NOT uploaded from the person's computer.`,
    "They are still on their laptop. Ask for what you need (a smaller upload, a .zip of one folder, or a GitHub link).",
    "",
  ];
  if (summary.leftOut.length > 0 && summary.leftOutBy) {
    lines.push(
      `Over the browser upload limit (${uploadLimitLine(summary.leftOutBy)}): ${summary.leftOut.length} files`,
      ...summary.leftOut,
      "",
    );
  }
  if (summary.tooLarge.length > 0) {
    lines.push(`Over 1 GB each: ${summary.tooLarge.length} files`, ...summary.tooLarge, "");
  }
  if (summary.skippedGroups.length > 0) {
    lines.push(
      `Skipped on purpose (rebuilt from the project's own files): ${summary.skippedGroups
        .map((group) => (group.files === null ? group.label : `${group.label} (${group.files})`))
        .join(", ")}`,
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// ── "Also skip": folders worth leaving out when the folder is too big ──

export type SkipSuggestionId = "vendor" | "worktrees";

export interface SkipSuggestion {
  readonly id: SkipSuggestionId;
  readonly label: string;
  /** Why it is safe, in one short line. */
  readonly hint: string;
  /** Relative folders it covers. */
  readonly folders: ReadonlyArray<string>;
}

interface SuggestionInput {
  readonly relativePath: string;
  readonly blob?: Blob;
}

const WORKTREE_GITDIR = /^gitdir:.*[\\/]worktrees[\\/]/m;

/**
 * Folders a big project usually doesn't need on the computer, found by what is
 * inside them, never by a guess:
 * - `vendor/` with Go's `modules.txt` or Composer's `autoload.php` — installed
 *   dependencies (`go mod vendor` / `composer install` bring them back);
 * - a subfolder whose `.git` is a file pointing into `…/worktrees/…` — a git
 *   worktree, a copy of another branch. Submodules (their `.git` points into
 *   `…/modules/…`) are real code and stay.
 */
export async function findSkipSuggestions(
  files: ReadonlyArray<SuggestionInput>,
): Promise<ReadonlyArray<SkipSuggestion>> {
  const vendor = new Set<string>();
  const gitFiles: SuggestionInput[] = [];
  for (const file of files) {
    const match = /^(.*\/)?vendor\/(modules\.txt|autoload\.php)$/.exec(file.relativePath);
    if (match) vendor.add(`${match[1] ?? ""}vendor`);
    if (file.relativePath.endsWith("/.git") && file.blob && file.blob.size < 1024) {
      gitFiles.push(file);
    }
  }
  const worktrees: string[] = [];
  for (const file of gitFiles) {
    const text = await file.blob!.text().catch(() => "");
    if (WORKTREE_GITDIR.test(text)) worktrees.push(file.relativePath.slice(0, -"/.git".length));
  }
  const suggestions: SkipSuggestion[] = [];
  if (vendor.size > 0) {
    suggestions.push({
      id: "vendor",
      label: vendor.size === 1 ? "The vendor folder" : `${vendor.size} vendor folders`,
      hint: "Installed dependencies: go mod vendor or composer install brings them back",
      folders: [...vendor].toSorted(),
    });
  }
  if (worktrees.length > 0) {
    suggestions.push({
      id: "worktrees",
      label: worktrees.length === 1 ? "A git worktree" : `${worktrees.length} git worktrees`,
      hint: "Copies of other branches of the same code",
      folders: worktrees.toSorted(),
    });
  }
  return suggestions;
}

/** The ticked suggestions as plan input (folder → label). */
export function skipFoldersFor(
  suggestions: ReadonlyArray<SkipSuggestion>,
  ticked: ReadonlySet<SkipSuggestionId>,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const suggestion of suggestions) {
    if (!ticked.has(suggestion.id)) continue;
    const label = suggestion.id === "vendor" ? "vendor" : "git worktrees";
    for (const folder of suggestion.folders) map.set(folder, label);
  }
  return map;
}

// ── Progress: percent by bytes, speed and time left ──

export interface ProgressSample {
  readonly at: number;
  readonly sentBytes: number;
  readonly completedFiles: number;
}

/** How far along, 0–100, by bytes (files only when there are no bytes to count). */
export function uploadPercent(progress: {
  readonly sentBytes: number;
  readonly totalBytes: number;
  readonly completedFiles: number;
  readonly totalFiles: number;
}): number {
  const fraction =
    progress.totalBytes > 0
      ? progress.sentBytes / progress.totalBytes
      : progress.totalFiles > 0
        ? progress.completedFiles / progress.totalFiles
        : 1;
  return Math.max(0, Math.min(100, Math.floor(fraction * 100)));
}

/**
 * Speed and time left from the last ~20 s of samples. Small files cost a round
 * trip each and big ones cost bandwidth, so neither bytes nor files alone tell
 * the pace: time left follows the blend of the two shares done. Null until
 * there is enough to say.
 */
export function uploadRate(
  samples: ReadonlyArray<ProgressSample>,
  totals: { readonly bytes: number; readonly files: number },
): { readonly bytesPerSecond: number; readonly secondsLeft: number | null } | null {
  if (samples.length < 2) return null;
  const last = samples.at(-1)!;
  const first = samples.find((sample) => last.at - sample.at <= 20_000) ?? samples[0]!;
  const seconds = (last.at - first.at) / 1000;
  if (seconds < 2) return null;
  const share = (sample: ProgressSample) => {
    const bytes = totals.bytes > 0 ? sample.sentBytes / totals.bytes : null;
    const files = totals.files > 0 ? sample.completedFiles / totals.files : null;
    if (bytes === null) return files ?? 1;
    if (files === null) return bytes;
    return (bytes + files) / 2;
  };
  const bytesPerSecond = (last.sentBytes - first.sentBytes) / seconds;
  const sharePerSecond = (share(last) - share(first)) / seconds;
  const secondsLeft = sharePerSecond > 0 ? Math.max(0, 1 - share(last)) / sharePerSecond : null;
  return { bytesPerSecond, secondsLeft };
}

/** "about 4 min left", "less than a minute left". */
export function timeLeftLine(secondsLeft: number | null): string | null {
  if (secondsLeft === null || !Number.isFinite(secondsLeft)) return null;
  if (secondsLeft < 60) return "less than a minute left";
  const minutes = Math.round(secondsLeft / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} h${rest > 0 ? ` ${rest} min` : ""} left`;
}

/** "2.4 MB/s". */
export function speedLine(bytesPerSecond: number): string {
  return `${formatUploadBytes(Math.max(0, Math.round(bytesPerSecond)))}/s`;
}

/** 20,000 with the thousands separated. */
export function count(value: number): string {
  return value.toLocaleString("en-US");
}
