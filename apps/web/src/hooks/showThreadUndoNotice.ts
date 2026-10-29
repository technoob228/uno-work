/**
 * One small "Done, ⌘Z to undo" note at the bottom of the sidebar instead of a
 * toast per action. Ported from upstream T3 Code `showThreadUndoNotice.ts`
 * (5781b5240b and follow-ups), rewritten on a plain zustand store: Work has
 * no atom registry, and its undo calls throw instead of returning results.
 *
 * - Actions of the same kind in a row group: "Done 3" undoes all three.
 * - The note lives 5 s; a newer action restarts the clock.
 * - Right after the action ⌘Z belongs to the note even inside a text field,
 *   until the person types or presses another key.
 */
import { create } from "zustand";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { ThreadUndoClaim } from "../lib/threadUndo";
import * as ThreadUndo from "../lib/threadUndo";

export type ThreadUndoNoticeAction = "Done" | "Snoozed" | "Unpinned" | "Archived";

export const THREAD_UNDO_NOTICE_TIMEOUT_MS = 5_000;

export interface ThreadUndoOptions {
  readonly action: ThreadUndoNoticeAction;
  readonly undo: () => Promise<void>;
  readonly failureTitle: string;
  readonly claim: ThreadUndoClaim;
}

export interface ThreadUndoNotice {
  readonly action: ThreadUndoNoticeAction;
  readonly count: number;
  readonly undo: () => Promise<void>;
}

export const useThreadUndoNotice = create<{ notice: ThreadUndoNotice | null }>(() => ({
  notice: null,
}));

/** "Done 1 chat", "Archived 3 chats" — the full sentence for screen readers. */
export function threadUndoNoticeSummary(
  notice: Pick<ThreadUndoNotice, "action" | "count">,
): string {
  return `${notice.action} ${notice.count} chat${notice.count === 1 ? "" : "s"}`;
}

let liveUndos: ThreadUndoOptions[] = [];
let expiry: ReturnType<typeof setTimeout> | undefined;
let shortcutClaimed = false;

function reportFailure(title: string, error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "Something went wrong.",
    }),
  );
}

function refreshNotice(): void {
  liveUndos = liveUndos.filter(({ claim }) => claim.isCurrent());
  const latest = liveUndos.at(-1);
  if (!latest) {
    clearTimeout(expiry);
    useThreadUndoNotice.setState({ notice: null });
    return;
  }
  // The latest run of the same action is one group: one Undo restores them all.
  const group: ThreadUndoOptions[] = [];
  for (let index = liveUndos.length - 1; index >= 0; index--) {
    const entry = liveUndos[index]!;
    if (entry.action !== latest.action) break;
    group.push(entry);
  }
  useThreadUndoNotice.setState({
    notice: {
      action: latest.action,
      count: group.length,
      undo: async () => {
        const current = group.filter(
          (entry) => liveUndos.includes(entry) && entry.claim.isCurrent(),
        );
        liveUndos = liveUndos.filter((entry) => !group.includes(entry));
        // Claim before awaiting so a double ⌘Z can't restore a group twice.
        for (const entry of current) entry.claim.finish();
        refreshNotice();
        await Promise.all(
          current.map(async ({ undo, failureTitle }) => {
            try {
              await undo();
            } catch (error) {
              reportFailure(failureTitle, error);
            }
          }),
        );
      },
    },
  });
}

ThreadUndo.subscribe(refreshNotice);

/** ⌘Z / the note's button: undo the latest group. False when there is nothing to undo. */
export function undoLatestThreadAction(): boolean {
  const notice = useThreadUndoNotice.getState().notice;
  if (!notice) return false;
  void notice.undo();
  return true;
}

/** Whether ⌘Z should undo the note's actions even while a text field is focused. */
export function threadUndoClaimsShortcut(): boolean {
  return shortcutClaimed && useThreadUndoNotice.getState().notice !== null;
}

/** Any other keypress or text edit hands ⌘Z back to text fields. */
export function releaseThreadUndoShortcut(): void {
  shortcutClaimed = false;
}

/** Shows (or extends) the note for a chat action that can be undone. */
export function showThreadUndoNotice(options: ThreadUndoOptions): void {
  if (!options.claim.isCurrent()) return;
  liveUndos.push(options);
  shortcutClaimed = true;
  refreshNotice();
  clearTimeout(expiry);
  expiry = setTimeout(() => {
    const expired = liveUndos;
    liveUndos = [];
    for (const { claim } of expired) claim.finish();
    refreshNotice();
  }, THREAD_UNDO_NOTICE_TIMEOUT_MS);
}

/** Tests only: forget every pending Undo. */
export function resetThreadUndoNoticeForTests(): void {
  const pending = liveUndos;
  liveUndos = [];
  for (const { claim } of pending) claim.finish();
  shortcutClaimed = false;
  clearTimeout(expiry);
  useThreadUndoNotice.setState({ notice: null });
}
