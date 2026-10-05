/**
 * Economy mode, client side (see components/computer/economyModel.ts).
 *
 * For every connected Uno computer this client talks to:
 *   - tells its daemon "the person is here" after a click or a key press
 *     (throttled) — an open tab the person actually uses keeps the computer
 *     awake, a forgotten one does not;
 *   - learns when the computer plans to sleep, and shortly before that — if
 *     the person is away — holds the reconnect gate (rpc/economyGate.ts), so
 *     the dropped socket does not wake the computer straight back up;
 *   - holds the gate as soon as the tab sits hidden and untouched (a
 *     background tab never wakes the computer — a tab merely becoming visible
 *     is not the person being back either);
 *   - opens the gate when the person comes back (a click or a key): the
 *     reconnect goes through the wake-on-request path and the computer is up
 *     in about a second;
 *   - says "Asleep" / "Waking…" in the computer chip while that happens
 *     (useEconomyPill; it used to be a floating pill on every screen).
 */
import type { EnvironmentId, UnoEconomyPresence } from "@t3tools/contracts";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "~/environmentApi";
import { usePrimaryEnvironmentId } from "~/environments/primary/context";
import { useSavedEnvironmentRegistryStore } from "~/environments/runtime";
import {
  PRIMARY_GATE_KEY,
  holdEconomyGate,
  isEconomyGateHeld,
  releaseEconomyGate,
} from "~/rpc/economyGate";

import {
  ECONOMY_HOLD_LEAD_MS,
  PRESENCE_INPUT_THROTTLE_MS,
  PRESENCE_POLL_MS,
  canReleaseOnVisible,
  shouldHoldReconnect,
  shouldHoldWhileHidden,
} from "../computer/economyModel";

const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
const WAKING_PILL_MAX_MS = 15_000;

/** What the pill says for the browser's own computer: null — nothing. */
export type PillState = "sleeping" | "waking" | null;
let pillState: PillState = null;
let wakingTimer: ReturnType<typeof setTimeout> | null = null;
const pillListeners = new Set<() => void>();

function setPill(next: PillState): void {
  if (wakingTimer) clearTimeout(wakingTimer);
  wakingTimer = next === "waking" ? setTimeout(() => setPill(null), WAKING_PILL_MAX_MS) : null;
  if (pillState === next) return;
  pillState = next;
  for (const listener of pillListeners) listener();
}

function subscribePill(listener: () => void): () => void {
  pillListeners.add(listener);
  return () => pillListeners.delete(listener);
}

/** Last time the person did anything in this window (shared by all computers). */
let lastInputAt: number | null = null;
const inputListeners = new Set<() => void>();
const visibilityListeners = new Set<() => void>();

function noteInput(): void {
  lastInputAt = Date.now();
  for (const listener of inputListeners) listener();
}

export function EconomyPresenceBootstrap() {
  const primaryId = usePrimaryEnvironmentId();
  const savedIds = useSavedEnvironmentRegistryStore(
    useShallow((state) => Object.keys(state.byId) as EnvironmentId[]),
  );

  useEffect(() => {
    // Only the person's own input counts: a tab becoming visible (a laptop
    // lid opening, a tab switch) used to count as "here" and woke the computer.
    const onInput = () => {
      if (document.visibilityState === "visible") noteInput();
    };
    const onVisibility = () => {
      for (const listener of visibilityListeners) listener();
    };
    for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <>
      {primaryId ? (
        <EconomyPresenceFor environmentId={primaryId} gateKey={PRIMARY_GATE_KEY} />
      ) : null}
      {savedIds.map((id) => (
        <EconomyPresenceFor key={id} environmentId={id} gateKey={id} />
      ))}
    </>
  );
}

function EconomyPresenceFor({
  environmentId,
  gateKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly gateKey: string;
}) {
  const presence = useRef<UnoEconomyPresence | null>(null);
  const lastSentInput = useRef(0);

  useEffect(() => {
    let disposed = false;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;

    const primary = gateKey === PRIMARY_GATE_KEY;
    const call = async (input: boolean) => {
      const api = readEnvironmentApi(environmentId);
      if (!api) return;
      try {
        // While the gate is held and the socket is down this waits for the
        // reconnect — that is fine, the answer is only useful after it.
        const next = await api.unoComputer.economyPresence({ input });
        if (disposed) return;
        presence.current = next;
        if (primary && pillState === "waking") setPill(null);
        if (isEconomyGateHeld(gateKey) && !shouldHoldReconnect(next, lastInputAt, Date.now())) {
          // The console changed its mind (an agent started, a message came).
          releaseEconomyGate(gateKey);
          if (primary) setPill(null);
        }
        scheduleHold();
      } catch {
        // An older daemon has no such method, or the socket is down: nothing to do.
      }
    };

    // Held because the tab sits hidden (no pill: the person isn't looking).
    let heldWhileHidden = false;
    const hidden = () => document.visibilityState === "hidden";

    const evaluate = () => {
      if (shouldHoldReconnect(presence.current, lastInputAt, Date.now())) {
        holdEconomyGate(gateKey);
        heldWhileHidden = false;
        if (primary) setPill("sleeping");
      }
    };

    const evaluateHidden = () => {
      if (isEconomyGateHeld(gateKey)) return;
      if (shouldHoldWhileHidden(presence.current, hidden(), lastInputAt, Date.now())) {
        holdEconomyGate(gateKey);
        heldWhileHidden = true;
      }
    };

    const onVisibility = () => {
      if (hidden()) {
        evaluateHidden();
        return;
      }
      if (!heldWhileHidden || !isEconomyGateHeld(gateKey)) return;
      if (canReleaseOnVisible(presence.current, Date.now())) {
        heldWhileHidden = false;
        releaseEconomyGate(gateKey);
      } else if (primary) {
        // Asleep: "Wake it" (or any click) brings it back.
        heldWhileHidden = false;
        setPill("sleeping");
      }
    };

    const scheduleHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
      const p = presence.current;
      if (!p?.enabled || !p.sleepAfter) return;
      const at = Date.parse(p.sleepAfter) - ECONOMY_HOLD_LEAD_MS;
      if (!Number.isFinite(at)) return;
      holdTimer = setTimeout(evaluate, Math.max(0, at - Date.now()));
    };

    const onInput = () => {
      heldWhileHidden = false;
      if (isEconomyGateHeld(gateKey)) {
        // The person is back: let the reconnect wake the computer.
        releaseEconomyGate(gateKey);
        if (primary) setPill("waking");
        void call(true);
        return;
      }
      const now = Date.now();
      if (now - lastSentInput.current < PRESENCE_INPUT_THROTTLE_MS) return;
      lastSentInput.current = now;
      void call(true);
    };

    inputListeners.add(onInput);
    visibilityListeners.add(onVisibility);
    void call(false);
    const poll = setInterval(() => {
      evaluateHidden();
      void call(false);
    }, PRESENCE_POLL_MS);
    return () => {
      disposed = true;
      inputListeners.delete(onInput);
      visibilityListeners.delete(onVisibility);
      clearInterval(poll);
      if (holdTimer) clearTimeout(holdTimer);
      releaseEconomyGate(gateKey);
    };
  }, [environmentId, gateKey]);

  return null;
}

/**
 * What economy mode is doing to the browser's own computer right now —
 * "sleeping" (the reconnect is held while the person is away) or "waking".
 * Said quietly in the computer chip (connectionStatus.ts); it used to be a
 * floating pill at the bottom of every screen.
 */
export function useEconomyPill(): PillState {
  return useSyncExternalStore(
    subscribePill,
    () => pillState,
    () => null,
  );
}

/** "Wake up" in the computer menu: let the held reconnect go and say "Waking…". */
export function wakeEconomyComputer(gateKey: string = PRIMARY_GATE_KEY): void {
  releaseEconomyGate(gateKey);
  if (gateKey === PRIMARY_GATE_KEY) setPill("waking");
}
