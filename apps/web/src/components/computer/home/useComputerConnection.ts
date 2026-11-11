/**
 * The connection to the computer a chip shows, as connectionStatus.ts words
 * it — read from the primary socket (the browser's own computer) or from a
 * saved computer's runtime state, plus economy mode holding the reconnect.
 *
 * Ticks once a second only while the link is down (the words change with
 * time: "Reconnecting…" → "Offline — retrying" → "No connection").
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { describeWorkRestartError, restartWorkOnComputer } from "../../../account/accountOverview";
import { accountTransport } from "../../../account/unoAccount";
import { isElectron } from "../../../env";
import { usePrimaryEnvironmentId } from "../../../environments/primary/context";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../../environments/runtime";
import { healSavedEnvironment } from "../../../environments/runtime/selfHeal";
import { useReconnectEnvironment } from "../../../hooks/useReconnectEnvironment";
import { isEconomyGateHeld, subscribeEconomyGate } from "../../../rpc/economyGate";
import { useWsConnectionStatus } from "../../../rpc/wsConnectionState";
import { useEconomyPill, wakeEconomyComputer } from "../../economy/EconomyPresence";
import { toastManager } from "../../ui/toast";
import { reconnectPrimaryNow } from "../../WebSocketConnectionSurface";
import {
  CONNECTED,
  describeConnection,
  type ConnectionAction,
  type ConnectionFacts,
  type ConnectionStatus,
} from "./connectionStatus";

const TICK_MS = 1_000;
/** "Restart now" goes back to "Restart" if not pressed within this. */
const RESTART_CONFIRM_MS = 8_000;
/**
 * Reconnect (quietly) after Uno Work restarted: at once when the console says
 * it answers again, a little later while it is still coming up.
 */
const RECONNECT_AFTER_RESTART_MS = { done: 500, restarting: 10_000 } as const;

function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function useGateHeld(key: string | null): boolean {
  return useSyncExternalStore(
    subscribeEconomyGate,
    () => (key === null ? false : isEconomyGateHeld(key)),
    () => false,
  );
}

type Facts = Omit<ConnectionFacts, "now" | "confirmingRestart">;

function usePrimaryFacts(): Facts {
  const ws = useWsConnectionStatus();
  const economy = useEconomyPill();
  return {
    link:
      ws.phase === "connected"
        ? "connected"
        : ws.hasConnected || ws.phase === "disconnected"
          ? "down"
          : "first",
    downSince: parseTime(ws.disconnectedAt),
    // The Mac app's own computer needs no network.
    networkOnline: ws.online || isElectron,
    economy,
    signInNeeded: false,
  };
}

function useSavedFacts(environmentId: EnvironmentId | null): Facts {
  const runtime = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null ? undefined : state.byId[environmentId],
  );
  const unoBoxId = useSavedEnvironmentRegistryStore((state) =>
    environmentId === null ? undefined : state.byId[environmentId]?.unoBoxId,
  );
  const held = useGateHeld(environmentId);
  const online = useSyncExternalStore(
    subscribeNetwork,
    () => navigator.onLine !== false,
    () => true,
  );
  const state = runtime?.connectionState ?? "connecting";
  return {
    link:
      state === "connected"
        ? "connected"
        : state === "connecting" && !runtime?.connectedAt
          ? "first"
          : "down",
    downSince: parseTime(runtime?.disconnectedAt) ?? parseTime(runtime?.lastErrorAt),
    networkOnline: online,
    economy: held ? "sleeping" : null,
    signInNeeded: runtime?.authState === "requires-auth",
    serverNotResponding: (runtime?.serverNotRespondingSince ?? null) !== null,
    canRestart: unoBoxId !== undefined && accountTransport() !== "none",
  };
}

/**
 * Restarts only Uno Work on an Uno computer through the account
 * (`POST /boxes/{id}/work/restart`); the computer and its programs keep
 * running. No fallback to restarting the whole computer: the person agreed to
 * restart Uno Work, not to stop their programs. Resolves to when to reconnect,
 * or null when it didn't work (the person got a message).
 */
async function restartUnoWork(environmentId: EnvironmentId): Promise<number | null> {
  const boxId = useSavedEnvironmentRegistryStore.getState().byId[environmentId]?.unoBoxId;
  if (boxId === undefined) return null;
  try {
    const answer = await restartWorkOnComputer(boxId);
    if (answer?.state === "failed") {
      toastManager.add({
        type: "error",
        title: "Uno Work didn't restart",
        description: answer.error ?? "Try again in a minute, or restart the computer.",
      });
      return null;
    }
    // It's restarting or back: the words go back to "Reconnecting…" until it's up.
    useSavedEnvironmentRuntimeStore
      .getState()
      .patch(environmentId, { serverNotRespondingSince: null });
    return answer?.state === "done"
      ? RECONNECT_AFTER_RESTART_MS.done
      : RECONNECT_AFTER_RESTART_MS.restarting;
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Couldn't restart Uno Work",
      description: describeWorkRestartError(error),
    });
    return null;
  }
}

function subscribeNetwork(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

export interface ComputerConnection {
  readonly status: ConnectionStatus;
  /** Runs `status.action`; null when there is none. */
  readonly act: (() => void) | null;
  readonly acting: boolean;
}

/** `tickMs`: how often the words move on while the link is down; a dot needs less than a line. */
export function useComputerConnection(
  environmentId: EnvironmentId | null,
  tickMs: number = TICK_MS,
): ComputerConnection {
  const primaryId = usePrimaryEnvironmentId();
  const isPrimary = environmentId === null || environmentId === primaryId;
  const primaryFacts = usePrimaryFacts();
  const savedFacts = useSavedFacts(isPrimary ? null : environmentId);
  const facts = isPrimary ? primaryFacts : savedFacts;
  const { reconnect, reconnectingId } = useReconnectEnvironment();
  const [primaryRetrying, setPrimaryRetrying] = useState(false);
  const [confirmingRestart, setConfirmingRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    if (!confirmingRestart) return;
    const id = window.setTimeout(() => setConfirmingRestart(false), RESTART_CONFIRM_MS);
    return () => window.clearTimeout(id);
  }, [confirmingRestart]);

  // The device says it has no network: the socket would take ~40 s to notice.
  const down = facts.link !== "connected" || !facts.networkOnline;
  const [clock, setClock] = useState(() => ({
    now: Date.now(),
    seenDownAt: null as number | null,
  }));
  useEffect(() => {
    if (!down) {
      setClock((current) =>
        current.seenDownAt === null ? current : { ...current, seenDownAt: null },
      );
      return;
    }
    // An outage whose start the runtime didn't record counts from when we saw it.
    const seenDownAt = Date.now();
    setClock({ now: seenDownAt, seenDownAt });
    const id = window.setInterval(
      () => setClock((current) => ({ ...current, now: Date.now() })),
      tickMs,
    );
    return () => window.clearInterval(id);
  }, [down, tickMs]);

  const status =
    !down && facts.economy === null && !facts.signInNeeded
      ? CONNECTED
      : describeConnection({
          ...facts,
          confirmingRestart,
          downSince: facts.downSince ?? clock.seenDownAt,
          now: clock.now,
        });

  const run = useCallback(
    (action: ConnectionAction) => {
      if (action === "restart") {
        setConfirmingRestart(true);
        return;
      }
      if (action === "restart-confirm") {
        if (environmentId === null) return;
        setConfirmingRestart(false);
        setRestarting(true);
        void restartUnoWork(environmentId).then((reconnectInMs) => {
          setRestarting(false);
          if (reconnectInMs === null) return;
          window.setTimeout(
            () => void healSavedEnvironment(environmentId, "work-restarted", { immediate: true }),
            reconnectInMs,
          );
        });
        return;
      }
      if (action === "wake") {
        wakeEconomyComputer(isPrimary || environmentId === null ? undefined : environmentId);
        return;
      }
      if (isPrimary || environmentId === null) {
        setPrimaryRetrying(true);
        void reconnectPrimaryNow().finally(() => setPrimaryRetrying(false));
        return;
      }
      // A saved computer: wakes it first if it sleeps, signs in when asked.
      void reconnect(environmentId);
    },
    [environmentId, isPrimary, reconnect],
  );

  const action = status.action;
  return {
    status,
    act: action ? () => run(action) : null,
    acting: isPrimary ? primaryRetrying : restarting || reconnectingId === environmentId,
  };
}

/** Is the link to this computer down right now (no clock, for screens that only hide noise)? */
export function useComputerLinkDown(environmentId: EnvironmentId | null): boolean {
  const primaryId = usePrimaryEnvironmentId();
  const isPrimary = environmentId === null || environmentId === primaryId;
  const ws = useWsConnectionStatus();
  const saved = useSavedEnvironmentRuntimeStore((state) =>
    isPrimary || environmentId === null ? undefined : state.byId[environmentId],
  );
  return isPrimary ? ws.phase !== "connected" : saved?.connectionState !== "connected";
}
