import { useCallback, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { getPrimaryKnownEnvironment } from "../environments/primary";
import { getSavedEnvironmentRecord, reconnectSavedEnvironment } from "../environments/runtime";
import { readEnvironmentApi } from "../environmentApi";
import { describeMachineError } from "../machineErrors";
import { boxNeedsWake, isBoxRunning } from "../unoBoxConnect";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

const WAKE_BUDGET_MS = 90_000;
const WAKE_POLL_MS = 3_000;

/**
 * A saved machine that is an Uno box and has fallen asleep answers nothing, so
 * a plain reconnect only fails with "Failed to fetch". Wake it through the Uno
 * account first and wait until Uno reports it running. Best effort: without an
 * account or box id the reconnect proceeds as before.
 */
async function wakeSavedBoxIfAsleep(environmentId: EnvironmentId): Promise<boolean> {
  const boxId = getSavedEnvironmentRecord(environmentId)?.unoBoxId;
  const accountEnvironmentId = getPrimaryKnownEnvironment()?.environmentId ?? null;
  if (boxId === undefined || accountEnvironmentId === null) return false;
  const api = readEnvironmentApi(accountEnvironmentId);
  if (!api) return false;
  const state = await api.unoCloud.getState({ refresh: true }).catch(() => null);
  const box = state?.boxes.find((candidate) => candidate.id === boxId);
  const action = box ? boxNeedsWake(box.status) : null;
  if (!action) return false;
  let current = await api.unoCloud.boxPower({ boxId, action });
  const deadline = Date.now() + WAKE_BUDGET_MS;
  while (Date.now() < deadline) {
    const status = current.boxes.find((candidate) => candidate.id === boxId)?.status;
    if (status && isBoxRunning(status)) return true;
    await new Promise((resolve) => setTimeout(resolve, WAKE_POLL_MS));
    current = await api.unoCloud.getState({ refresh: true }).catch(() => current);
  }
  return true;
}

export function useReconnectEnvironment() {
  const [reconnectingId, setReconnectingId] = useState<EnvironmentId | null>(null);
  const [wakingId, setWakingId] = useState<EnvironmentId | null>(null);

  const reconnect = useCallback(async (environmentId: EnvironmentId) => {
    setReconnectingId(environmentId);
    try {
      setWakingId(environmentId);
      const woke = await wakeSavedBoxIfAsleep(environmentId).catch(() => false);
      setWakingId(null);
      // A just-woken box's address comes up a few seconds after "running".
      const attempts = woke ? 6 : 1;
      for (let attempt = 1; ; attempt += 1) {
        try {
          await reconnectSavedEnvironment(environmentId);
          break;
        } catch (error) {
          if (attempt >= attempts || !describeMachineError(error).transient) throw error;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
    } catch (error) {
      const human = describeMachineError(error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: human.title,
          description: human.message,
        }),
      );
    } finally {
      setWakingId(null);
      setReconnectingId(null);
    }
  }, []);

  return { reconnect, reconnectingId, wakingId };
}
