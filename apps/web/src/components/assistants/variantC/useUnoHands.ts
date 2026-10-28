/**
 * Variant C (28.10): Uno works on every computer of the account — there is
 * nothing to set up on each one and no second assistant there. What the
 * person sees per computer is "Uno on <computer>": is it awake, what Uno runs
 * there now, what waits for them. The sidebar (under Uno), the computer
 * switcher and Uno's page read it from here.
 */
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useMachineRows } from "../../../hooks/useMachineRows";
import type { MachineKind } from "../../../machineKind";
import type { MachineStatus } from "../../../plainLanguage";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../../../store";
import type { SidebarThreadSummary } from "../../../types";
import { resolveSidebarThreadStatus } from "../../Sidebar.logic";

export interface UnoHand {
  readonly key: string;
  readonly environmentId: string | null;
  readonly label: string;
  readonly kind: MachineKind;
  readonly status: MachineStatus;
  /** The computer serving this page (the one Uno lives on, in the browser). */
  readonly isPrimary: boolean;
  /** Chats running there now (Uno's or yours). */
  readonly running: ReadonlyArray<SidebarThreadSummary>;
  /** Chats there that wait for you (an Allow, a question). */
  readonly waiting: ReadonlyArray<SidebarThreadSummary>;
}

/** One short line for a computer: "1 running", "waits for you", "asleep — Uno's tasks wait". */
export function handLine(hand: UnoHand): string {
  if (hand.status === "sleeping" || hand.status === "offline") {
    return hand.kind === "computer" ? "asleep · tasks wait" : "asleep";
  }
  if (hand.waiting.length > 0)
    return `${hand.waiting.length} wait${hand.waiting.length === 1 ? "s" : ""} for you`;
  if (hand.running.length > 0) return `${hand.running.length} running`;
  return hand.isPrimary ? "always on" : "ready";
}

export function handAwake(hand: UnoHand): boolean {
  return hand.status === "online";
}

export function useUnoHands(): ReadonlyArray<UnoHand> {
  const rows = useMachineRows();
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  return useMemo(
    () =>
      rows.map((row) => {
        const here = threads.filter(
          (thread) => row.environmentId !== null && thread.environmentId === row.environmentId,
        );
        const statusOf = (thread: SidebarThreadSummary) => resolveSidebarThreadStatus(thread);
        return {
          key: row.key,
          environmentId: row.environmentId,
          label: row.label,
          kind: row.kind,
          status: row.status,
          isPrimary: row.isPrimary,
          running: here.filter((thread) => statusOf(thread) === "working"),
          waiting: here.filter((thread) => {
            const status = statusOf(thread);
            return status === "approval" || status === "input";
          }),
        };
      }),
    [rows, threads],
  );
}
