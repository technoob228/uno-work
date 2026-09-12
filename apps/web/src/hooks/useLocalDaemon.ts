/**
 * "Use this computer" for the browser build.
 *
 * `useLocalDaemonDiscovery` looks once per page session for a Uno Work
 * desktop daemon on the computer the browser runs on (see
 * localDaemonDiscovery.ts); `refresh()` looks again on demand.
 *
 * `useUseThisComputer` does the whole thing on click: if the daemon is
 * already a saved machine, just switch to it; otherwise ask the desktop app
 * for approval, bootstrap with the one-time credential it hands back, save
 * the environment as "This computer (<label>)" and switch to it.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { addSavedEnvironment, getSavedEnvironmentRecord } from "../environments/runtime";
import { discoverLocalDaemon, type LocalDaemonDescriptor } from "../localDaemonDiscovery";
import { describeBrowserForLink, requestLocalDaemonLink } from "../localDaemonLink";
import { isWebApp } from "../webMode";
import { useSwitchEnvironment } from "./useSwitchEnvironment";

let discoveryPromise: Promise<LocalDaemonDescriptor | null> | null = null;
let discovered: LocalDaemonDescriptor | null | undefined;
const discoveryListeners = new Set<() => void>();

function notifyDiscovery() {
  for (const listener of discoveryListeners) {
    listener();
  }
}

function runDiscovery(force: boolean): Promise<LocalDaemonDescriptor | null> {
  if (!isWebApp) {
    return Promise.resolve(null);
  }
  if (!force && discoveryPromise) {
    return discoveryPromise;
  }
  if (!force && discovered !== undefined) {
    return Promise.resolve(discovered);
  }
  const next = discoverLocalDaemon().then((result) => {
    discovered = result;
    if (discoveryPromise === next) {
      discoveryPromise = null;
    }
    notifyDiscovery();
    return result;
  });
  discoveryPromise = next;
  notifyDiscovery();
  return next;
}

export function resetLocalDaemonDiscoveryForTests() {
  discoveryPromise = null;
  discovered = undefined;
  discoveryListeners.clear();
}

export interface LocalDaemonDiscoveryState {
  readonly daemon: LocalDaemonDescriptor | null;
  readonly isProbing: boolean;
  readonly refresh: () => Promise<LocalDaemonDescriptor | null>;
}

export function useLocalDaemonDiscovery(options?: {
  readonly enabled?: boolean;
}): LocalDaemonDiscoveryState {
  const enabled = (options?.enabled ?? true) && isWebApp;
  const [, rerender] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const listener = () => rerender((tick) => tick + 1);
    discoveryListeners.add(listener);
    void runDiscovery(false);
    return () => {
      discoveryListeners.delete(listener);
    };
  }, [enabled]);

  const refresh = useCallback(() => runDiscovery(true), []);

  return {
    daemon: enabled ? (discovered ?? null) : null,
    isProbing: enabled && discoveryPromise !== null,
    refresh,
  };
}

export type UseThisComputerPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "waiting-for-approval" }
  | { readonly kind: "linking" };

export function localDaemonEnvironmentLabel(daemon: Pick<LocalDaemonDescriptor, "label">) {
  return `This computer (${daemon.label})`;
}

export function useUseThisComputer() {
  const switchEnvironment = useSwitchEnvironment();
  const [phase, setPhase] = useState<UseThisComputerPhase>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const run = useCallback(
    async (daemon: LocalDaemonDescriptor) => {
      if (abortRef.current) {
        return;
      }
      // Already linked: this is just a switch, no new approval.
      if (getSavedEnvironmentRecord(daemon.environmentId)) {
        switchEnvironment(daemon.environmentId);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setPhase({ kind: "waiting-for-approval" });
      try {
        const outcome = await requestLocalDaemonLink({
          daemon,
          origin: window.location.origin,
          label: `${describeBrowserForLink(navigator.userAgent)} · ${window.location.host}`,
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        switch (outcome.status) {
          case "denied":
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Denied on the computer",
                description: "Uno Work on this computer did not allow the browser to use it.",
              }),
            );
            return;
          case "timeout":
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "No answer — is Uno Work open on this computer?",
                description: "Open the Uno Work app, then try again.",
              }),
            );
            return;
          case "unavailable":
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not ask this computer",
                description: outcome.message,
              }),
            );
            return;
          case "approved":
            break;
        }

        setPhase({ kind: "linking" });
        const record = await addSavedEnvironment({
          label: localDaemonEnvironmentLabel(daemon),
          host: daemon.httpBaseUrl,
          pairingCode: outcome.credential,
        });
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "This computer is ready",
            description: `${record.label} is now one of your machines.`,
          }),
        );
        switchEnvironment(record.environmentId);
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not connect this computer",
            description: error instanceof Error ? error.message : String(error),
          }),
        );
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setPhase({ kind: "idle" });
      }
    },
    [switchEnvironment],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase({ kind: "idle" });
  }, []);

  return { phase, run, cancel, isBusy: phase.kind !== "idle" };
}
