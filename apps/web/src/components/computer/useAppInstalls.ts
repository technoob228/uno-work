/**
 * Installs in flight on this screen. An install is a control-plane deployment;
 * the daemon exposes one poll (`uno.computer.installStatus`) that returns the
 * new progress lines since the last poll, so the UI can show the install
 * talking — "Downloading…", "Starting…" — and then "Running" with its address.
 */
import type {
  EnvironmentId,
  UnoComputerAppTemplate,
  UnoComputerInstalledApp,
} from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import { computerQueryKeys } from "./computerQueries";

const POLL_MS = 1_200;
const MAX_LINES = 30;

export interface AppInstall {
  readonly deploymentId: number;
  readonly name: string;
  readonly icon: string | null;
  readonly templateId: string | null;
  readonly state: "installing" | "running" | "failed";
  readonly lines: ReadonlyArray<string>;
  readonly url: string | null;
}

export function useAppInstalls(input: {
  readonly environmentId: EnvironmentId | null;
  readonly boxId: number | null;
  /** Installs the daemon reports as still running, to re-attach after a reload. */
  readonly inFlight: ReadonlyArray<UnoComputerInstalledApp>;
}) {
  const { environmentId, boxId } = input;
  const queryClient = useQueryClient();
  const [installs, setInstalls] = useState<ReadonlyArray<AppInstall>>([]);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ templateId: string; message: string } | null>(null);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const active = timers.current;
    return () => {
      for (const timer of active.values()) clearTimeout(timer);
      active.clear();
    };
  }, []);

  const update = useCallback((deploymentId: number, patch: (prev: AppInstall) => AppInstall) => {
    setInstalls((prev) => prev.map((i) => (i.deploymentId === deploymentId ? patch(i) : i)));
  }, []);

  const follow = useCallback(
    (deploymentId: number, afterSeq: number) => {
      if (environmentId === null) return;
      const tick = async (seq: number) => {
        try {
          const status = await ensureEnvironmentApi(environmentId).unoComputer.installStatus({
            deploymentId,
            afterSeq: seq,
          });
          update(deploymentId, (prev) => ({
            ...prev,
            state: status.state,
            url: status.url ?? prev.url,
            lines: [...prev.lines, ...status.lines.map((l) => l.text)].slice(-MAX_LINES),
          }));
          if (status.state === "installing") {
            timers.current.set(
              deploymentId,
              setTimeout(() => void tick(status.nextSeq), POLL_MS),
            );
          } else {
            timers.current.delete(deploymentId);
            void queryClient.invalidateQueries({
              queryKey: computerQueryKeys.apps(environmentId, boxId),
            });
          }
        } catch {
          // A missed poll is not a failed install: try again a little later.
          timers.current.set(
            deploymentId,
            setTimeout(() => void tick(seq), POLL_MS * 3),
          );
        }
      };
      void tick(afterSeq);
    },
    [boxId, environmentId, queryClient, update],
  );

  // Re-attach to installs that were already running when the screen opened.
  useEffect(() => {
    for (const app of input.inFlight) {
      if (app.state !== "installing" || app.deploymentId === null) continue;
      const deploymentId = app.deploymentId;
      if (timers.current.has(deploymentId)) continue;
      setInstalls((prev) =>
        prev.some((i) => i.deploymentId === deploymentId)
          ? prev
          : [
              ...prev,
              {
                deploymentId,
                name: app.name,
                icon: app.icon,
                templateId: app.templateId,
                state: "installing",
                lines: [],
                url: null,
              },
            ],
      );
      timers.current.set(
        deploymentId,
        setTimeout(() => undefined, 0),
      );
      follow(deploymentId, 0);
    }
  }, [follow, input.inFlight]);

  const install = useCallback(
    async (
      template: UnoComputerAppTemplate,
      settings?: Record<string, string>,
      options?: { allowLowMemory?: boolean },
    ) => {
      if (environmentId === null) return false;
      setStartError(null);
      setConfirm(null);
      setStarting(template.id);
      try {
        const result = await ensureEnvironmentApi(environmentId).unoComputer.installApp({
          ...(boxId === null ? {} : { boxId }),
          templateId: template.id,
          ...(settings && Object.keys(settings).length > 0 ? { settings } : {}),
          ...(options?.allowLowMemory ? { allowLowMemory: true } : {}),
        });
        const deploymentId = result.deploymentId;
        if (deploymentId === null) {
          // Uno wants the person's answer first (the app needs more memory).
          setConfirm({
            templateId: template.id,
            message: result.confirm?.message ?? "This app needs your confirmation to install.",
          });
          return false;
        }
        setInstalls((prev) => [
          ...prev.filter((i) => i.deploymentId !== deploymentId),
          {
            deploymentId,
            name: template.name,
            icon: template.icon || null,
            templateId: template.id,
            state: "installing",
            lines: [],
            url: null,
          },
        ]);
        timers.current.set(
          deploymentId,
          setTimeout(() => undefined, 0),
        );
        follow(deploymentId, 0);
        return true;
      } catch (cause) {
        setStartError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        setStarting(null);
      }
    },
    [boxId, environmentId, follow],
  );

  const dismiss = useCallback((deploymentId: number) => {
    setInstalls((prev) => prev.filter((i) => i.deploymentId !== deploymentId));
  }, []);

  return {
    installs,
    install,
    starting,
    startError,
    clearStartError: () => setStartError(null),
    confirm,
    clearConfirm: () => setConfirm(null),
    dismiss,
  };
}
