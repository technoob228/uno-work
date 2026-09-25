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
 *   - opens the gate when the person comes back (click, key, tab visible):
 *     the reconnect goes through the wake-on-request path and the computer is
 *     up in about a second;
 *   - shows a small "Economy · sleeping / waking" pill while that happens.
 */
import type { EnvironmentId, UnoEconomyPresence } from "@t3tools/contracts";
import { MoonIcon, SunIcon } from "lucide-react";
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
  shouldHoldReconnect,
} from "../computer/economyModel";

const INPUT_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
const WAKING_PILL_MAX_MS = 15_000;

/** What the pill says for the browser's own computer: null — nothing. */
type PillState = "sleeping" | "waking" | null;
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
    const onVisible = () => {
      if (document.visibilityState === "visible") noteInput();
    };
    for (const name of INPUT_EVENTS) window.addEventListener(name, noteInput, { passive: true });
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      for (const name of INPUT_EVENTS) window.removeEventListener(name, noteInput);
      document.removeEventListener("visibilitychange", onVisible);
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
      <EconomyGatePill />
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

    const evaluate = () => {
      if (shouldHoldReconnect(presence.current, lastInputAt, Date.now())) {
        holdEconomyGate(gateKey);
        if (primary) setPill("sleeping");
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
    void call(false);
    const poll = setInterval(() => void call(false), PRESENCE_POLL_MS);
    return () => {
      disposed = true;
      inputListeners.delete(onInput);
      clearInterval(poll);
      if (holdTimer) clearTimeout(holdTimer);
      releaseEconomyGate(gateKey);
    };
  }, [environmentId, gateKey]);

  return null;
}

/** "Economy · sleeping — Wake it" / "Economy · waking…" for the browser's own computer. */
function EconomyGatePill() {
  const state = useSyncExternalStore(
    subscribePill,
    () => pillState,
    () => null,
  );
  if (state === null) return null;
  if (state === "waking") {
    return (
      <div
        role="status"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center"
      >
        <div className="inline-flex items-center gap-2 rounded-full bg-card/95 px-4 py-2 text-xs shadow-lg ring-1 ring-border">
          <SunIcon className="size-3.5 animate-pulse text-warning" />
          <span className="font-medium">Economy · waking</span>
          <span className="text-muted-foreground">About a second…</span>
        </div>
      </div>
    );
  }
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center"
    >
      <div className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-card/95 px-4 py-2 text-xs shadow-lg ring-1 ring-border">
        <MoonIcon className="size-3.5 text-info" />
        <span className="font-medium">Economy · sleeping</span>
        <span className="text-muted-foreground">Your computer rests while you're away.</span>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
          onClick={() => {
            releaseEconomyGate(PRIMARY_GATE_KEY);
            setPill("waking");
          }}
        >
          <SunIcon className="size-3.5" />
          Wake it
        </button>
      </div>
    </div>
  );
}
