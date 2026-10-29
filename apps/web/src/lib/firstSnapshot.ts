/**
 * "The computer hasn't sent its chats yet" — one answer for every screen that
 * would otherwise draw an empty state on the first frames of a start or a
 * reload (Misha 29.10: "elements vanish, come back, vanish, come back").
 *
 * Before: the sidebar drew "Add a project / New chat" while the active
 * computer was still unknown, swapped it for grey rows once it was known, then
 * for the list; "/" showed "Start your first chat" to a person with chats
 * until the snapshot came and the redirect took them to the latest chat.
 *
 * Pending = a computer to wait for is known (the active one, or the primary
 * one before the welcome picks it) and its first snapshot hasn't arrived —
 * capped, so a computer that never answers still ends on the real empty state.
 * The cap counts from page load, not from each mount: a remounted sidebar
 * must not start its grey rows over.
 */
import { useEffect, useState } from "react";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { selectEnvironmentState, useStore } from "../store";

/** How long a screen waits for the computer's first snapshot before its empty state. */
export const FIRST_SNAPSHOT_MAX_WAIT_MS = 8_000;

const pageStartedAt = typeof performance !== "undefined" ? performance.now() : 0;

function graceLeftMs(): number {
  if (typeof performance === "undefined") return 0;
  return Math.max(0, FIRST_SNAPSHOT_MAX_WAIT_MS - (performance.now() - pageStartedAt));
}

/** Pure rule (tested): is the first snapshot still worth waiting for? */
export function isFirstSnapshotPending(input: {
  readonly waitedEnvironmentId: string | null;
  readonly bootstrapComplete: boolean;
  readonly graceOver: boolean;
}): boolean {
  return input.waitedEnvironmentId !== null && !input.bootstrapComplete && !input.graceOver;
}

/**
 * True once FIRST_SNAPSHOT_MAX_WAIT_MS have passed since page load — the same
 * cap for anything else a screen holds back on its first frames (Home's
 * "AI plan limits" sign-in check).
 */
export function useFirstSnapshotGraceOver(): boolean {
  const [graceOver, setGraceOver] = useState(() => graceLeftMs() === 0);
  useEffect(() => {
    if (graceOver) return;
    const timer = window.setTimeout(() => setGraceOver(true), graceLeftMs());
    return () => window.clearTimeout(timer);
  }, [graceOver]);
  return graceOver;
}

export function useFirstSnapshotPending(): boolean {
  const activeEnvironmentId = useStore((store) => store.activeEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const waitedEnvironmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, waitedEnvironmentId).bootstrapComplete,
  );
  const graceOver = useFirstSnapshotGraceOver();
  return isFirstSnapshotPending({ waitedEnvironmentId, bootstrapComplete, graceOver });
}
