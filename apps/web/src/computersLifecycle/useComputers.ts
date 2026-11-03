/**
 * Computers lifecycle: where the person's own computers are asked about, and
 * what the cloud computer says about them (contracts computers.ts).
 *
 * "Connect my computer" lives on a cloud computer (its machine token opens the
 * tunnel). In the browser that is the computer serving the page; in the desktop
 * app the page is served by this Mac, so it is the first cloud computer that is
 * connected. That computer is the "host" here.
 */
import type {
  ComputerPurpose,
  ComputersState,
  EnvironmentId,
  MyComputer,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

import { ensureEnvironmentApi } from "../environmentApi";
import { useMachineRows } from "../hooks/useMachineRows";
import { useMyComputers } from "../localComputer/useMyComputers";
import { setLifecycleServerFlag } from "./flag";

const COMPUTERS_KEY = ["computers"] as const;
const OFF: ComputersState = { lifecycle: false, purposes: [] };
/** The flag can change on the console: ask again now and then. */
const STATE_POLL_MS = 60_000;

/** The cloud computer that answers for the person's own computers (null: none connected). */
export function useComputersHostId(): EnvironmentId | null {
  const rows = useMachineRows();
  return useMemo(() => {
    const boxes = rows.filter((row) => row.kind === "uno_box" && row.environmentId !== null);
    const primary = boxes.find((row) => row.isPrimary);
    if (primary) return primary.environmentId;
    return boxes.find((row) => row.status === "online")?.environmentId ?? null;
  }, [rows]);
}

export function useComputersState(hostId: EnvironmentId | null): ComputersState {
  const query = useQuery({
    queryKey: [...COMPUTERS_KEY, "state", hostId],
    queryFn: () => ensureEnvironmentApi(hostId!).computers.state(),
    enabled: hostId !== null,
    staleTime: 15_000,
    retry: false,
    refetchInterval: STATE_POLL_MS,
    refetchIntervalInBackground: false,
  });
  return query.data ?? OFF;
}

/** Mounted once (root): keeps the flag in step with the cloud computer. */
export function ComputersLifecycleSync() {
  const hostId = useComputersHostId();
  const state = useComputersState(hostId);
  useEffect(() => {
    setLifecycleServerFlag(state.lifecycle);
  }, [state.lifecycle]);
  return null;
}

export interface OwnComputer extends MyComputer {
  readonly purpose: ComputerPurpose;
}

/** The person's own computers with what each is for (a tool unless chosen). */
export function useOwnComputers(options: { readonly pollMs?: number } = {}) {
  const hostId = useComputersHostId();
  const { computers, settled, enabled } = useMyComputers(hostId, options);
  const state = useComputersState(hostId);
  const own = useMemo(() => {
    const purposeOf = new Map(state.purposes.map((entry) => [entry.computerId, entry.purpose]));
    return computers.map(
      (computer): OwnComputer => ({ ...computer, purpose: purposeOf.get(computer.id) ?? "tool" }),
    );
  }, [computers, state.purposes]);
  return { hostId, computers: own, settled, enabled };
}

export function useComputerPurpose(computerId: string | null): ComputerPurpose | null {
  const hostId = useComputersHostId();
  const state = useComputersState(hostId);
  if (computerId === null) return null;
  return state.purposes.find((entry) => entry.computerId === computerId)?.purpose ?? "tool";
}

/** Saves what a computer is for; the answer is the new state. */
export function useSetComputerPurpose() {
  const queryClient = useQueryClient();
  const hostId = useComputersHostId();
  return useCallback(
    async (computerId: string, purpose: ComputerPurpose) => {
      if (hostId === null) throw new Error("Uno isn’t connected yet. Try again.");
      const next = await ensureEnvironmentApi(hostId).computers.setPurpose({
        computerId,
        purpose,
      });
      queryClient.setQueryData([...COMPUTERS_KEY, "state", hostId], next);
      return next;
    },
    [hostId, queryClient],
  );
}

export function useRefreshComputersState() {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: [...COMPUTERS_KEY, "state"] }),
    [queryClient],
  );
}

export const computersQueryKeys = {
  all: COMPUTERS_KEY,
  work: (hostId: EnvironmentId | null, computerId: string | null) =>
    [...COMPUTERS_KEY, "work", hostId, computerId] as const,
};

/** The message of a failed call, for people. */
export function errorText(cause: unknown, fallback = "Uno didn’t answer. Try again."): string {
  return cause instanceof Error && cause.message.trim() !== "" ? cause.message : fallback;
}

/** The backend part isn't there yet (CONTRACT.md §2): the screen leaves it out. */
export function isNotAvailableYet(cause: unknown): boolean {
  return cause instanceof Error && /not available yet/i.test(cause.message);
}
