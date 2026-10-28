/**
 * Words for Settings → Computer → "Chat copies": the one quiet line and the
 * choices under Advanced. The daemon does the cleanup (server
 * `worktreeCleanup/`); this only describes it.
 */
import type {
  StorageCleanupReport,
  StorageCleanupReportEntry,
  StorageCleanupSettings,
} from "@t3tools/contracts";

import { formatBytes } from "../computer/resources/resourceModel";

export function cleanupIsOff(settings: StorageCleanupSettings): boolean {
  return (
    !settings.worktreeOnDelete &&
    settings.worktreeSettledAfterDays === null &&
    settings.worktreeAfterDays === null
  );
}

/** "Old chat copies are cleaned up automatically · last run freed 1.2 GB". */
export function cleanupSummaryLine(
  settings: StorageCleanupSettings,
  report: StorageCleanupReport | null,
): string {
  if (cleanupIsOff(settings)) return "Old chat copies are not cleaned up automatically.";
  const base = "Old chat copies are cleaned up automatically";
  if (report === null) return `${base}.`;
  if (report.counts.removed === 0) return `${base} · nothing to clean last time`;
  if (report.bytesFreed > 0) return `${base} · last run freed ${formatBytes(report.bytesFreed)}`;
  return `${base} · last run removed ${copies(report.counts.removed)}`;
}

function copies(count: number): string {
  return count === 1 ? "1 copy" : `${count} copies`;
}

export const SETTLED_DAY_CHOICES: ReadonlyArray<number | null> = [0, 1, 3, 7, 14, 30, null];
export const IDLE_DAY_CHOICES: ReadonlyArray<number | null> = [3, 7, 14, 30, 60, 90, null];

export function dayChoiceLabel(days: number | null): string {
  if (days === null) return "Never";
  if (days === 0) return "Right away";
  return days === 1 ? "After 1 day" : `After ${days} days`;
}

/** Keeps a value the daemon has that is not one of the presets selectable. */
export function withCurrentChoice(
  choices: ReadonlyArray<number | null>,
  current: number | null,
): ReadonlyArray<number | null> {
  if (choices.includes(current)) return choices;
  const days = [...choices, current].filter((choice): choice is number => choice !== null);
  return [...days.sort((a, b) => a - b), null];
}

export function encodeDayChoice(days: number | null): string {
  return days === null ? "never" : String(days);
}

export function decodeDayChoice(value: string): number | null {
  if (value === "never") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function reportEntryLine(entry: StorageCleanupReportEntry): string {
  const title = entry.threadTitle ?? entry.path ?? "A chat copy";
  const size = entry.bytes !== null && entry.outcome === "removed" ? ` · ${formatBytes(entry.bytes)}` : "";
  const saved = entry.saved ? " · changes saved" : "";
  return `${title}: ${entry.reason}${size}${saved}`;
}

export function reportHeadline(report: StorageCleanupReport): string {
  const parts = [
    `${copies(report.counts.removed)} removed`,
    `${report.counts.kept} kept`,
    ...(report.counts.failed > 0 ? [`${report.counts.failed} couldn't be removed`] : []),
  ];
  const when = new Date(report.finishedAt).toLocaleString();
  return `${when}: ${parts.join(", ")}${report.lowDisk ? " (disk was nearly full)" : ""}`;
}
