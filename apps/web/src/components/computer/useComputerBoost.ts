/**
 * Boost ×2 for an hour on the computer this screen looks at.
 *
 * Starting or ending a boost restarts the computer, and this screen's daemon
 * may run on it: the answer can be lost with the connection. So the request
 * is remembered as `pending` and the screen shows "Restarting into boost…"
 * until the computer's own state (read every few seconds, and again after the
 * reconnect) agrees. A lost answer is never shown as an error; a refusal from
 * Uno is, in its plain words.
 */
import type {
  EnvironmentId,
  UnoComputerBoost,
  UnoComputerBoostResult,
  UnoComputerState,
} from "@t3tools/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import {
  BOOST_DROP_SETTLE_MS,
  BOOST_SWITCHING_REFETCH_MS,
  type BoostPending,
  isConnectionDrop,
  pendingSettled,
  shownBoostState,
} from "./boostModel";
import { computerQueryKeys } from "./computerQueries";

export interface ComputerBoostControls {
  readonly boost: UnoComputerBoost;
  /** What to show: the computer's state, or the one just asked for. */
  readonly state: UnoComputerBoost["state"];
  /** A request is on its way (the button is busy). */
  readonly busy: boolean;
  readonly error: string | null;
  readonly start: () => void;
  readonly end: () => void;
  readonly clearError: () => void;
}

export function useComputerBoost({
  environmentId,
  boxId,
  boost,
  stateUpdatedAt,
}: {
  environmentId: EnvironmentId | null;
  /** The picked box; null = the machine this daemon runs on. */
  boxId: number | null;
  /** From `box.boost`; undefined = boost isn't offered, nothing shows. */
  boost: UnoComputerBoost | undefined;
  /** When the computer's state was last read (`dataUpdatedAt`). */
  stateUpdatedAt: number;
}): ComputerBoostControls | null {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<BoostPending | null>(null);
  const [error, setError] = useState<string | null>(null);

  const putBoost = useCallback(
    (next: UnoComputerBoost | null) => {
      if (!next) return;
      queryClient.setQueryData(
        computerQueryKeys.state(environmentId, boxId),
        (prev: UnoComputerState | undefined) =>
          prev?.box ? { ...prev, box: { ...prev.box, boost: next } } : prev,
      );
    },
    [queryClient, environmentId, boxId],
  );

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: computerQueryKeys.state(environmentId, boxId),
    });
  }, [queryClient, environmentId, boxId]);

  const onAnswer = (result: UnoComputerBoostResult) => {
    putBoost(result.boost);
    if (result.outcome === "refused") {
      setPending(null);
      setError(result.message ?? "Uno didn't boost this computer.");
    }
    refresh();
  };
  const onFailure = (cause: unknown) => {
    if (isConnectionDrop(cause)) {
      // The computer is restarting (most likely into the boost): wait for it.
      setPending((prev) => (prev ? { ...prev, droppedAt: Date.now() } : prev));
      return;
    }
    setPending(null);
    setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
    refresh();
  };

  const target = boxId === null ? {} : { boxId };
  const startMutation = useMutation({
    mutationKey: ["uno-computer", "boost", environmentId, boxId] as const,
    mutationFn: () =>
      ensureEnvironmentApi(environmentId!).unoComputer.boost({ ...target, hours: 1 }),
    onSuccess: onAnswer,
    onError: onFailure,
  });
  const endMutation = useMutation({
    mutationKey: ["uno-computer", "end-boost", environmentId, boxId] as const,
    mutationFn: () => ensureEnvironmentApi(environmentId!).unoComputer.endBoost(target),
    onSuccess: onAnswer,
    onError: onFailure,
  });

  // While waiting, read the computer every few seconds (the daemon may be
  // restarting: failed reads just try again), and stop waiting once it agrees.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(refresh, BOOST_SWITCHING_REFETCH_MS);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  useEffect(() => {
    if (!pending || !boost) return;
    const now = Date.now();
    if (pendingSettled(pending, boost, now)) {
      setPending(null);
      return;
    }
    // The answer was lost, the computer is back, and it still isn't boosted:
    // the request never got through.
    if (
      pending.kind === "start" &&
      pending.droppedAt !== null &&
      stateUpdatedAt > pending.droppedAt + BOOST_DROP_SETTLE_MS
    ) {
      setPending(null);
      setError("The boost didn't start. Try again.");
    }
  }, [boost, pending, stateUpdatedAt]);

  if (!boost) return null;
  return {
    boost,
    state: shownBoostState(boost, pending),
    busy: startMutation.isPending || endMutation.isPending,
    error,
    start: () => {
      setError(null);
      setPending({ kind: "start", at: Date.now(), droppedAt: null });
      startMutation.mutate();
    },
    end: () => {
      setError(null);
      setPending({ kind: "end", at: Date.now(), droppedAt: null });
      endMutation.mutate();
    },
    clearError: () => setError(null),
  };
}
