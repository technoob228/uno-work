/**
 * Undo for the chat actions that move a chat out of sight: Done (settle),
 * snooze, unpin and archive. Pure logic, ported from upstream T3 Code
 * `packages/client-runtime/src/state/threadUndo.ts` (5781b5240b, #12848, and
 * follow-ups 6b0a04ade0 / 9a609a4e44 / 21da3061aa / 1549046fd2 / 35b298a159),
 * adapted to Work's commands: a pin is restored by writing the old `pinnedAt`
 * back (we have no pin order key), and archive is undone by unarchive.
 *
 * Ownership: every action takes a claim per (kind, chat). Doing the opposite
 * by hand (unsettle, wake, pin) or the same action again invalidates the
 * older claim, so a stale Undo can never revert the person's newer choice.
 */

// Shared across hook instances so sidebar, header and shortcut actions invalidate each other.
const currentActions = new Map<string, symbol>();
const listeners = new Set<() => void>();

export type ThreadUndoKind = "settle" | "snooze" | "unpin" | "archive";

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

export interface ThreadUndoClaim {
  readonly isCurrent: () => boolean;
  readonly finish: () => void;
}

export function begin(kind: ThreadUndoKind, threadKey: string): ThreadUndoClaim {
  const key = JSON.stringify([kind, threadKey]);
  const token = Symbol();
  currentActions.set(key, token);
  notify();
  const isCurrent = () => currentActions.get(key) === token;
  return {
    isCurrent,
    finish: () => {
      if (isCurrent()) {
        currentActions.delete(key);
        notify();
      }
    },
  };
}

export function invalidate(kind: ThreadUndoKind, threadKey: string): void {
  if (!currentActions.delete(JSON.stringify([kind, threadKey]))) return;
  notify();
}

export type ThreadUndoStep =
  | { readonly action: "unsettle" }
  | { readonly action: "unsnooze" }
  | { readonly action: "unarchive" }
  | { readonly action: "pin"; readonly pinnedAt: string }
  | { readonly action: "snooze"; readonly snoozedUntil: string };

export type ThreadUndoPlan = readonly [ThreadUndoStep, ...ThreadUndoStep[]];

/** What the chat looked like just before the action (read from the store). */
export interface ThreadUndoSnapshot {
  readonly pinnedAt?: string | null | undefined;
  readonly snoozedUntil?: string | null | undefined;
}

export function planThreadUndo(
  kind: ThreadUndoKind,
  before?: ThreadUndoSnapshot | null,
): ThreadUndoPlan {
  if (kind === "snooze") return [{ action: "unsnooze" }];
  if (kind === "archive") return [{ action: "unarchive" }];
  const pinnedAt = before?.pinnedAt ?? new Date().toISOString();
  const pin: ThreadUndoStep = { action: "pin", pinnedAt };
  if (kind === "unpin") return [pin];
  // Settling clears the pin and the snooze on the server: put both back.
  const snooze =
    before?.snoozedUntil != null
      ? [{ action: "snooze" as const, snoozedUntil: before.snoozedUntil }]
      : [];
  return [{ action: "unsettle" }, ...(before?.pinnedAt != null ? [pin] : []), ...snooze];
}

/**
 * Runs the plan in order; a failing step throws and stops the rest. A snooze
 * that expired while the Undo was waiting is skipped (the server rejects a
 * wake time in the past).
 */
export async function executeThreadUndo(
  plan: ThreadUndoPlan,
  execute: (step: ThreadUndoStep) => Promise<void>,
  now: () => number = Date.now,
): Promise<void> {
  for (const step of plan) {
    if (step.action === "snooze" && Date.parse(step.snoozedUntil) <= now()) continue;
    await execute(step);
  }
}
