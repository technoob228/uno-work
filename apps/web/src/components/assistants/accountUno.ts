/**
 * One Uno per account (assistants D, 28.10; audit 27.10 line 8: every computer
 * showed a Uno of its own). Uno lives on the account's home computer — the
 * cloud computer when it is up, else the computer serving this app — and the
 * personas live next to it (PersonaCreator's "where it lives" is the same
 * rule). Uno folders on other computers stay where they are; the sidebar and
 * the pages show the home one.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useMachineRows } from "../../hooks/useMachineRows";
import type { MachineRow } from "../settings/machineRows";

type HomeRow = Pick<MachineRow, "kind" | "environmentId" | "status" | "isPrimary">;

/** The cloud computer when it is up, else the one serving this app. Pure. */
export function pickHomeEnvironmentId(rows: ReadonlyArray<HomeRow>): EnvironmentId | null {
  const cloud =
    rows.find((row) => row.kind === "uno_box" && row.environmentId && row.status !== "offline") ??
    rows.find((row) => row.isPrimary && row.environmentId) ??
    null;
  return cloud?.environmentId ?? null;
}

/**
 * Of the Unos the app sees, the account's one: the home computer's; without
 * it there (not connected yet), the one the person talked to last. Pure.
 */
export function pickAccountUno<T extends { readonly environmentId: string }>(
  unos: ReadonlyArray<T>,
  input: {
    readonly homeEnvironmentId: string | null;
    readonly lastTalkMs: (uno: T) => number;
  },
): T | undefined {
  const home = unos.find((uno) => uno.environmentId === input.homeEnvironmentId);
  if (home) return home;
  return unos.toSorted((a, b) => input.lastTalkMs(b) - input.lastTalkMs(a))[0];
}

/** The account's home computer, where Uno and the personas live. */
export function useAccountHomeEnvironmentId(): EnvironmentId | null {
  const rows = useMachineRows();
  return useMemo(() => pickHomeEnvironmentId(rows), [rows]);
}
