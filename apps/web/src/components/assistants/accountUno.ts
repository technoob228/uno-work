/**
 * One Uno per account (assistants D, 28.10; audit 27.10 line 8: every computer
 * showed a Uno of its own). Uno lives on the account's home computer — the
 * cloud computer when it is up, else the computer serving this app — and the
 * personas live next to it (PersonaCreator's "where it lives" is the same
 * rule). Uno folders on other computers stay where they are; the sidebar and
 * the pages show the home one.
 */
import {
  ASSISTANT_PROJECT_ID,
  type EnvironmentId,
  type ManagerAssistantSummary,
} from "@t3tools/contracts";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { useMachineRows } from "../../hooks/useMachineRows";
import { listAssistants } from "../../lib/managerApi";
import type { MachineRow } from "../settings/machineRows";
import { LOCAL_ASSISTANTS_KEY } from "./useAssistants";

type HomeRow = Pick<MachineRow, "kind" | "environmentId" | "status" | "isPrimary">;

/**
 * Where Uno moved (assistant move, 10.11), as each computer's Uno says:
 * `movedInAt` — it lives here since then; `movedAway` — it left this one.
 */
export interface UnoMoveClaims {
  readonly movedInAt: ReadonlyMap<string, string>;
  readonly movedAway: ReadonlySet<string>;
}

const NO_CLAIMS: UnoMoveClaims = { movedInAt: new Map(), movedAway: new Set() };

/**
 * The computer Uno lives on. The person's choice wins: the computer Uno last
 * moved to (while the app knows it). Else, as before: the cloud computer
 * when it is up — never one Uno moved away from — else the one serving this
 * app. Pure.
 */
export function pickHomeEnvironmentId(
  rows: ReadonlyArray<HomeRow>,
  claims: UnoMoveClaims = NO_CLAIMS,
): EnvironmentId | null {
  const known = rows.filter((row) => row.environmentId);
  const claimed = known
    .filter((row) => claims.movedInAt.has(row.environmentId!))
    .toSorted((a, b) =>
      claims.movedInAt
        .get(b.environmentId!)!
        .localeCompare(claims.movedInAt.get(a.environmentId!)!),
    )[0];
  if (claimed) return claimed.environmentId;
  const left = (row: HomeRow) => claims.movedAway.has(row.environmentId!);
  const cloud =
    known.find((row) => row.kind === "uno_box" && row.status !== "offline" && !left(row)) ??
    known.find((row) => row.isPrimary && !left(row)) ??
    known.find((row) => row.kind === "uno_box" && row.status !== "offline") ??
    known.find((row) => row.isPrimary) ??
    null;
  return cloud?.environmentId ?? null;
}

/** Claims out of each computer's list of assistants (its Uno's `move` mark). Pure. */
export function unoMoveClaims(
  lists: ReadonlyArray<{
    readonly environmentId: string;
    readonly assistants: ReadonlyArray<ManagerAssistantSummary> | null;
  }>,
): UnoMoveClaims {
  const movedInAt = new Map<string, string>();
  const movedAway = new Set<string>();
  for (const list of lists) {
    const uno = list.assistants?.find((item) => item.projectId === ASSISTANT_PROJECT_ID);
    if (uno?.move?.movedInAt) movedInAt.set(list.environmentId, uno.move.movedInAt);
    if (uno?.move?.movedTo) movedAway.add(list.environmentId);
  }
  return { movedInAt, movedAway };
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
  const environmentIds = useMemo(
    () =>
      [
        ...new Set(rows.flatMap((row) => (row.environmentId ? [row.environmentId] : []))),
      ].toSorted(),
    [rows],
  );
  // The same query (and cache) as the team's lists of assistants.
  const lists = useQueries({
    queries: environmentIds.map((environmentId) => ({
      queryKey: [...LOCAL_ASSISTANTS_KEY, "team", environmentId],
      queryFn: async () =>
        (await listAssistants({ environmentId: environmentId as EnvironmentId })).assistants,
      refetchInterval: 15_000,
      staleTime: 5_000,
      retry: false,
    })),
    combine: (results) => results.map((result) => result.data ?? null),
  });
  const claims = useMemo(
    () =>
      unoMoveClaims(
        environmentIds.map((environmentId, index) => ({
          environmentId,
          assistants: lists[index] ?? null,
        })),
      ),
    [environmentIds, lists],
  );
  return useMemo(() => pickHomeEnvironmentId(rows, claims), [rows, claims]);
}
