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

import { usePrimaryEnvironmentId } from "../../../environments/primary/context";
import { useSavedEnvironmentRuntimeStore } from "../../../environments/runtime";
import { useReconnectEnvironment } from "../../../hooks/useReconnectEnvironment";
import { isEconomyGateHeld, subscribeEconomyGate } from "../../../rpc/economyGate";
import { useWsConnectionStatus } from "../../../rpc/wsConnectionState";
import { useEconomyPill, wakeEconomyComputer } from "../../economy/EconomyPresence";
import { reconnectPrimaryNow } from "../../WebSocketConnectionSurface";
import {
  CONNECTED,
  describeConnection,
  type ConnectionAction,
  type ConnectionFacts,
  type ConnectionStatus,
} from "./connectionStatus";

const TICK_MS = 1_000;

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

type Facts = Omit<ConnectionFacts, "now">;

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
    networkOnline: ws.online,
    economy,
    signInNeeded: false,
  };
}

function useSavedFacts(environmentId: EnvironmentId | null): Facts {
  const runtime = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null ? undefined : state.byId[environmentId],
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
  };
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

export function useComputerConnection(environmentId: EnvironmentId | null): ComputerConnection {
  const primaryId = usePrimaryEnvironmentId();
  const isPrimary = environmentId === null || environmentId === primaryId;
  const primaryFacts = usePrimaryFacts();
  const savedFacts = useSavedFacts(isPrimary ? null : environmentId);
  const facts = isPrimary ? primaryFacts : savedFacts;
  const { reconnect, reconnectingId } = useReconnectEnvironment();
  const [primaryRetrying, setPrimaryRetrying] = useState(false);

  const down = facts.link !== "connected";
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
      TICK_MS,
    );
    return () => window.clearInterval(id);
  }, [down]);

  const status =
    !down && facts.economy === null && !facts.signInNeeded
      ? CONNECTED
      : describeConnection({
          ...facts,
          downSince: facts.downSince ?? clock.seenDownAt,
          now: clock.now,
        });

  const run = useCallback(
    (action: ConnectionAction) => {
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
    acting: isPrimary ? primaryRetrying : reconnectingId === environmentId,
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
