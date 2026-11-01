/**
 * The daemon's "Connect my computer", for screens. Every poll here is tied to a
 * mounted screen and stops while the tab is hidden: nothing runs in the
 * background, and coming back to the tab asks again at once.
 *
 * A status that can't be fetched reads as off. An older daemon, or one that
 * isn't connected yet, shows no trace of the feature; a hiccup after a good
 * answer keeps the last one, so the row doesn't blink.
 */
import type { EnvironmentId, MyComputerPairStatus, MyComputerStatus } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { ensureEnvironmentApi } from "../environmentApi";
import { localComputer, useLocalComputer } from "./localComputerStore";

const MY_COMPUTER_KEY = ["my-computer"] as const;
const OFF: MyComputerStatus = { enabled: false, computers: [] };

/** A screen that stays open: Settings, the setup step. */
export const STATUS_POLL_SCREEN_MS = 15_000;
/** The manage card, where someone is looking at this one computer. */
export const STATUS_POLL_CARD_MS = 5_000;
/** A pairing in progress: the code was taken, the helper is coming up. */
export const STATUS_POLL_PAIRING_MS = 2_000;
const PAIR_POLL_MS = 2_000;
const ACTIVITY_POLL_MS = 10_000;
const ACTIVITY_LIMIT = 50;

export function useMyComputers(
  environmentId: EnvironmentId | null,
  options: { readonly pollMs?: number | undefined } = {},
) {
  const query = useQuery({
    queryKey: [...MY_COMPUTER_KEY, "status", environmentId],
    queryFn: () => ensureEnvironmentApi(environmentId!).myComputer.status(),
    enabled: environmentId !== null,
    staleTime: 15_000,
    retry: false,
    refetchInterval: options.pollMs ?? false,
    refetchIntervalInBackground: false,
  });
  const status = query.data ?? OFF;
  return {
    enabled: status.enabled,
    computers: status.computers,
    /** The moment of the last answer: "last seen" counts from it. */
    updatedAt: query.dataUpdatedAt,
    /** The first answer came (or failed), so an absent computer really is absent. */
    settled: !query.isPending,
  };
}

function pairPoll(status: MyComputerPairStatus | undefined, expiresAt: string): number | false {
  if (status?.state === "expired") return false;
  // A failure stays `failed` past the deadline, and a code out of time can't change.
  if (status?.state === "failed" && Date.now() >= Date.parse(expiresAt)) return false;
  return PAIR_POLL_MS;
}

export function usePairStatus(
  environmentId: EnvironmentId | null,
  pairing: { readonly code: string; readonly expiresAt: string } | null,
) {
  const code = pairing?.code ?? null;
  const expiresAt = pairing?.expiresAt ?? "";
  return useQuery({
    queryKey: [...MY_COMPUTER_KEY, "pair", environmentId, code],
    queryFn: () => ensureEnvironmentApi(environmentId!).myComputer.pairStatus({ code: code! }),
    enabled: environmentId !== null && code !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (query) => pairPoll(query.state.data, expiresAt),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

export function useMyComputerActivity(environmentId: EnvironmentId | null, computerId: string) {
  return useQuery({
    queryKey: [...MY_COMPUTER_KEY, "activity", environmentId, computerId],
    queryFn: () =>
      ensureEnvironmentApi(environmentId!).myComputer.activity({
        computerId,
        limit: ACTIVITY_LIMIT,
      }),
    enabled: environmentId !== null,
    staleTime: 5_000,
    retry: false,
    refetchInterval: ACTIVITY_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** Refreshes the rows behind the dialog after something changed. */
export function useRefreshMyComputers() {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: [...MY_COMPUTER_KEY, "status"] }),
    [queryClient],
  );
}

const errorText = (cause: unknown) =>
  cause instanceof Error && cause.message.trim() !== ""
    ? cause.message
    : "Uno didn’t answer. Try again.";

/** A code and its commands. The dialog shows the failure, nothing else does. */
export async function requestPairing(environmentId: EnvironmentId | null): Promise<void> {
  localComputer.pairRequested();
  try {
    if (environmentId === null) throw new Error("Uno isn’t connected yet. Try again.");
    const pairing = await ensureEnvironmentApi(environmentId).myComputer.pair();
    // Closed while the code was on its way: a late answer must not reopen anything.
    if (useLocalComputer.getState().dialog !== "connect") return;
    localComputer.paired(pairing);
  } catch (cause) {
    localComputer.pairFailed(errorText(cause));
  }
}

export async function disconnectComputer(
  environmentId: EnvironmentId | null,
  computerId: string,
): Promise<string | null> {
  try {
    if (environmentId === null) throw new Error("Uno isn’t connected yet. Try again.");
    await ensureEnvironmentApi(environmentId).myComputer.disconnect({ computerId });
    return null;
  } catch (cause) {
    return errorText(cause);
  }
}
