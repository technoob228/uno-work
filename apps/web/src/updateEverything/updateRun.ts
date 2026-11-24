/**
 * The run of an update, kept outside the dialog: closing the window doesn't
 * stop it or lose what each computer said, and opening it again (from the
 * notice or from Settings) shows the same run. One run at a time per page.
 */
import { useSyncExternalStore } from "react";

import type { PlanRow, RowProgress } from "./updateEverything.logic";

export interface UpdateRunState {
  readonly phase: "idle" | "running" | "finished";
  /** The rows the run was started with (the list may change meanwhile). */
  readonly rows: ReadonlyArray<PlanRow>;
  readonly progress: ReadonlyMap<string, RowProgress>;
  /** This app's own update, when it was part of the run. */
  readonly app: { readonly version: string | null; readonly error: string | null } | null;
}

const IDLE: UpdateRunState = { phase: "idle", rows: [], progress: new Map(), app: null };

let state: UpdateRunState = IDLE;
const listeners = new Set<() => void>();

function set(next: UpdateRunState) {
  state = next;
  for (const listener of listeners) listener();
}

export function getUpdateRun(): UpdateRunState {
  return state;
}

export function subscribeUpdateRun(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUpdateRun(): UpdateRunState {
  return useSyncExternalStore(subscribeUpdateRun, getUpdateRun, getUpdateRun);
}

export function beginUpdateRun(
  rows: ReadonlyArray<PlanRow>,
  app: { readonly version: string | null } | null,
): boolean {
  if (state.phase === "running") return false;
  set({ phase: "running", rows, progress: new Map(), app: app ? { ...app, error: null } : null });
  return true;
}

export function reportUpdateProgress(key: string, progress: RowProgress): void {
  set({ ...state, progress: new Map(state.progress).set(key, progress) });
}

export function reportAppError(error: string): void {
  if (state.app) set({ ...state, app: { ...state.app, error } });
}

export function finishUpdateRun(): void {
  set({ ...state, phase: "finished" });
}

/** The finished run was seen: the next open starts from a fresh list. */
export function clearUpdateRun(): void {
  if (state.phase !== "running") set(IDLE);
}
