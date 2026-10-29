/**
 * Wiring between Work's chat commands and the Undo note
 * (`showThreadUndoNotice`). Call sites take a snapshot of the chat BEFORE the
 * action, run it, then offer the Undo; doing the opposite by hand withdraws
 * the offer (`withdrawThreadUndo`).
 *
 * Also the open chat's keyboard actions (⌘⇧S Done, ⌘⇧P pin) — they go
 * through the same commands and offer the same Undo.
 */
import { scopedThreadKey } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { readEnvironmentApi } from "../environmentApi";
import { readEnvironmentSupportsThreadSettlement } from "../environments/threadSettlementSupport";
import { newCommandId } from "../lib/utils";
import * as ThreadUndo from "../lib/threadUndo";
import { selectSidebarThreadSummaryByRef, useStore } from "../store";
import { type ThreadUndoNoticeAction, showThreadUndoNotice } from "./showThreadUndoNotice";

const NOTICE_ACTION: Record<ThreadUndo.ThreadUndoKind, ThreadUndoNoticeAction> = {
  settle: "Done",
  snooze: "Snoozed",
  unpin: "Unpinned",
  archive: "Archived",
};

const FAILURE_TITLE: Record<ThreadUndo.ThreadUndoKind, string> = {
  settle: "Couldn't bring the chat back",
  snooze: "Couldn't wake the chat",
  unpin: "Couldn't pin the chat again",
  archive: "Couldn't unarchive the chat",
};

/** The chat's pin and snooze right now — what an Undo has to put back. */
export function snapshotThreadForUndo(threadRef: ScopedThreadRef): ThreadUndo.ThreadUndoSnapshot {
  const summary = selectSidebarThreadSummaryByRef(useStore.getState(), threadRef);
  return { pinnedAt: summary?.pinnedAt ?? null, snoozedUntil: summary?.snoozedUntil ?? null };
}

async function dispatchUndoStep(
  threadRef: ScopedThreadRef,
  step: ThreadUndo.ThreadUndoStep,
): Promise<void> {
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) throw new Error("This computer is not connected right now.");
  const base = { commandId: newCommandId(), threadId: threadRef.threadId } as const;
  switch (step.action) {
    case "unsettle":
      await api.orchestration.dispatchCommand({ type: "thread.unsettle", ...base, reason: "user" });
      return;
    case "unsnooze":
      await api.orchestration.dispatchCommand({ type: "thread.unsnooze", ...base, reason: "user" });
      return;
    case "unarchive":
      await api.orchestration.dispatchCommand({ type: "thread.unarchive", ...base });
      // Same as useThreadActions.unarchiveThread: don't wait for the push stream.
      useStore.getState().setThreadArchivedAt(threadRef, null);
      return;
    case "pin":
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        ...base,
        pinnedAt: step.pinnedAt,
      });
      return;
    case "snooze":
      await api.orchestration.dispatchCommand({
        type: "thread.snooze",
        ...base,
        snoozedUntil: step.snoozedUntil,
      });
      return;
  }
}

/** After a successful Done / snooze / unpin / archive: show the Undo note for it. */
export function offerThreadUndo(
  kind: ThreadUndo.ThreadUndoKind,
  threadRef: ScopedThreadRef,
  before: ThreadUndo.ThreadUndoSnapshot,
): void {
  const plan = ThreadUndo.planThreadUndo(kind, before);
  showThreadUndoNotice({
    action: NOTICE_ACTION[kind],
    failureTitle: FAILURE_TITLE[kind],
    claim: ThreadUndo.begin(kind, scopedThreadKey(threadRef)),
    undo: () => ThreadUndo.executeThreadUndo(plan, (step) => dispatchUndoStep(threadRef, step)),
  });
}

/** The person reversed it by hand (un-done, woke, pinned, unarchived): drop the stale Undo. */
export function withdrawThreadUndo(kind: ThreadUndo.ThreadUndoKind, threadRef: ScopedThreadRef) {
  ThreadUndo.invalidate(kind, scopedThreadKey(threadRef));
}

export type OpenThreadShortcutResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * ⌘⇧S on the open chat: Done when it can be parked, back to the list when it
 * already is (upstream 143341b0bc). A working chat or one waiting on an
 * answer can't be parked — the server refuses those too.
 */
export async function toggleOpenThreadDone(
  threadRef: ScopedThreadRef,
): Promise<OpenThreadShortcutResult> {
  const summary = selectSidebarThreadSummaryByRef(useStore.getState(), threadRef);
  if (!summary) return { ok: false, reason: "This chat isn't loaded yet." };
  if (!readEnvironmentSupportsThreadSettlement(threadRef.environmentId)) {
    return { ok: false, reason: "This computer's Work is too old for Done. Update it first." };
  }
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) return { ok: false, reason: "This computer is not connected right now." };
  const base = { commandId: newCommandId(), threadId: threadRef.threadId } as const;
  if (summary.settledOverride === "settled") {
    withdrawThreadUndo("settle", threadRef);
    await api.orchestration.dispatchCommand({ type: "thread.unsettle", ...base, reason: "user" });
    return { ok: true };
  }
  const status = summary.session?.orchestrationStatus;
  if (status === "running" || status === "starting") {
    return { ok: false, reason: "The chat is still working. Stop it first." };
  }
  if (summary.hasPendingApprovals || summary.hasPendingUserInput) {
    return { ok: false, reason: "The chat is waiting for your answer." };
  }
  const before = snapshotThreadForUndo(threadRef);
  await api.orchestration.dispatchCommand({ type: "thread.settle", ...base });
  offerThreadUndo("settle", threadRef, before);
  return { ok: true };
}

/** ⌘⇧P on the open chat: pin it, or unpin it with an Undo. */
export async function toggleOpenThreadPin(
  threadRef: ScopedThreadRef,
): Promise<OpenThreadShortcutResult> {
  const summary = selectSidebarThreadSummaryByRef(useStore.getState(), threadRef);
  if (!summary) return { ok: false, reason: "This chat isn't loaded yet." };
  const api = readEnvironmentApi(threadRef.environmentId);
  if (!api) return { ok: false, reason: "This computer is not connected right now." };
  const before = snapshotThreadForUndo(threadRef);
  const pinned = summary.pinnedAt != null;
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId: threadRef.threadId,
    pinnedAt: pinned ? null : new Date().toISOString(),
  });
  if (pinned) offerThreadUndo("unpin", threadRef, before);
  else withdrawThreadUndo("unpin", threadRef);
  return { ok: true };
}
