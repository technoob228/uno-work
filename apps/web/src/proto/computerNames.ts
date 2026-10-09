/**
 * The computers in view, for the multi-computer sidebar (icp3 09.10, built on
 * the w0115 prototype that read them from fixtures).
 *
 * - `useComputerNames` — name, kind and Home folder of every computer this
 *   page knows, so plain helpers (machineLabel, placeParts) can say
 *   "brand-kit · uno-product" without a hook.
 * - `useSyncComputerNames` — keeps it in step with the machine rows.
 * - `useJoinAccountComputers` — "All my computers together" (Misha's mode Б):
 *   the account's other cloud computers that are on join this page in the
 *   background, so their chats are in the list without switching. A computer
 *   that sleeps is not woken for a list (economy) — it joins when it is up.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { resolveHomeFolder } from "../hooks/useFolderChats";
import { useMachineRows } from "../hooks/useMachineRows";
import { connectUnoBox, isBoxRunning } from "../unoBoxConnect";
import { useProtoAllMachines } from "./protoState";

export interface ComputerName {
  readonly label: string;
  readonly kind: "uno_box" | "computer";
  /** `~` on that computer, once known. */
  readonly home: string | null;
}

interface ComputerNamesState {
  readonly byId: Readonly<Record<string, ComputerName>>;
  /** Cloud computers first, then by name. */
  readonly order: ReadonlyArray<string>;
}

export const useComputerNames = create<ComputerNamesState>(() => ({ byId: {}, order: [] }));

export function computerOrder(byId: Readonly<Record<string, ComputerName>>): string[] {
  return Object.keys(byId).toSorted((left, right) => {
    const a = byId[left]!;
    const b = byId[right]!;
    if (a.kind !== b.kind) return a.kind === "uno_box" ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

export function useSyncComputerNames(): void {
  const rows = useMachineRows();
  useEffect(() => {
    const previous = useComputerNames.getState().byId;
    const byId: Record<string, ComputerName> = {};
    for (const row of rows) {
      if (!row.environmentId) continue;
      byId[row.environmentId] = {
        label: row.label,
        kind: row.kind === "uno_box" ? "uno_box" : "computer",
        home: previous[row.environmentId]?.home ?? null,
      };
    }
    useComputerNames.setState({ byId, order: computerOrder(byId) });
    for (const environmentId of Object.keys(byId)) {
      if (byId[environmentId]!.home) continue;
      void resolveHomeFolder(environmentId as EnvironmentId).then((home) => {
        if (!home) return;
        const current = useComputerNames.getState();
        const entry = current.byId[environmentId];
        if (!entry || entry.home === home) return;
        useComputerNames.setState({
          byId: { ...current.byId, [environmentId]: { ...entry, home } },
        });
      });
    }
  }, [rows]);
}

export function useJoinAccountComputers(enabled: boolean): void {
  const rows = useMachineRows();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // One try per computer per page: a computer that can't be reached now stays
  // in the switcher ("More on your account") and joins on the next load.
  const tried = useRef(new Set<number>());
  useEffect(() => {
    if (!enabled || !primaryEnvironmentId) return;
    for (const row of rows) {
      const box = row.box;
      if (!box || row.environmentId !== null || tried.current.has(box.id)) continue;
      if (box.workMachine === false || !isBoxRunning(box.status)) continue;
      tried.current.add(box.id);
      void connectUnoBox(primaryEnvironmentId, box, { budgetMs: 45_000 }).catch(() => undefined);
    }
  }, [enabled, primaryEnvironmentId, rows]);
}

/**
 * Sidebar v2 (Misha 09.10): with computers joined and 2+ of them, the
 * computer is the chip in the new-chat field (ProtoMachineChip) — the
 * "which computer" pill in Home's and the chat's header steps aside, so the
 * page doesn't say "you are inside X". One computer: the pill stays.
 */
export function useProtoComputerInComposer(): boolean {
  const joined = useProtoAllMachines();
  const count = useComputerNames((state) => state.order.length);
  return joined && count >= 2;
}
