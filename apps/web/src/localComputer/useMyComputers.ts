/**
 * The daemon's "Connect my computer", for screens. Every poll here is tied to a
 * mounted screen and stops while the tab is hidden: nothing runs in the
 * background, and coming back to the tab asks again at once.
 *
 * A status that can't be fetched reads as off. An older daemon, or one that
 * isn't connected yet, shows no trace of the feature; a hiccup after a good
 * answer keeps the last one, so the row doesn't blink.
 */
import type {
  EnvironmentId,
  MyComputerPairStatus,
  MyComputerRevokeGrantInput,
  MyComputerStatus,
  MyComputerStopAllResult,
  MyComputerTrustSettings,
  MyComputerTrustState,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

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
/** Settings → My computer and the Inbox's banner: is anything running there? */
export const TRUST_POLL_MS = 10_000;

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

export function useMyComputerActivity(
  environmentId: EnvironmentId | null,
  computerId: string,
  options: { readonly limit?: number } = {},
) {
  const limit = options.limit ?? ACTIVITY_LIMIT;
  return useQuery({
    queryKey: [...MY_COMPUTER_KEY, "activity", environmentId, computerId, limit],
    queryFn: () => ensureEnvironmentApi(environmentId!).myComputer.activity({ computerId, limit }),
    enabled: environmentId !== null,
    staleTime: 5_000,
    retry: false,
    refetchInterval: ACTIVITY_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

const trustKey = (environmentId: EnvironmentId | null) =>
  [...MY_COMPUTER_KEY, "trust", environmentId] as const;

/**
 * What agents may do on the person's computers, the chats' Allows, the pause
 * and what runs now. Polls only while a screen that shows it is mounted.
 */
export function useMyComputerTrust(
  environmentId: EnvironmentId | null,
  options: { readonly pollMs?: number | undefined; readonly enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: trustKey(environmentId),
    queryFn: () => ensureEnvironmentApi(environmentId!).myComputer.trust(),
    enabled: environmentId !== null && (options.enabled ?? true),
    staleTime: 5_000,
    retry: false,
    refetchInterval: options.pollMs ?? false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Changing the trust settings, revoking a chat's Allow, Resume and Stop all.
 * Each answers the new state, which replaces the cached one; a failure throws
 * a sentence to show (`myComputerErrorText`).
 */
export function useMyComputerTrustActions(environmentId: EnvironmentId | null) {
  const queryClient = useQueryClient();
  return useMemo(() => {
    const key = trustKey(environmentId);
    const api = () => {
      if (environmentId === null) throw new Error("Uno isn’t connected yet. Try again.");
      return ensureEnvironmentApi(environmentId).myComputer;
    };
    const keep = (state: MyComputerTrustState) => {
      queryClient.setQueryData(key, state);
      return state;
    };
    return {
      /** Replaces the whole settings object; the form shows it before the answer. */
      setTrust: async (settings: MyComputerTrustSettings) => {
        const before = queryClient.getQueryData<MyComputerTrustState>(key);
        if (before !== undefined) queryClient.setQueryData(key, { ...before, settings });
        try {
          return keep(await api().setTrust(settings));
        } catch (cause) {
          if (before !== undefined) queryClient.setQueryData(key, before);
          throw cause;
        }
      },
      revokeGrant: async (input: MyComputerRevokeGrantInput) =>
        keep(await api().revokeGrant(input)),
      resume: async () => keep(await api().resume()),
      stopAll: async (): Promise<MyComputerStopAllResult> => {
        const result = await api().stopAll();
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: key }),
          queryClient.invalidateQueries({ queryKey: [...MY_COMPUTER_KEY, "status"] }),
          queryClient.invalidateQueries({ queryKey: [...MY_COMPUTER_KEY, "activity"] }),
        ]);
        return result;
      },
    };
  }, [environmentId, queryClient]);
}

/** Refreshes the rows behind the dialog after something changed. */
export function useRefreshMyComputers() {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: [...MY_COMPUTER_KEY, "status"] }),
    [queryClient],
  );
}

export const myComputerErrorText = (cause: unknown) =>
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
    localComputer.pairFailed(myComputerErrorText(cause));
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
    return myComputerErrorText(cause);
  }
}
