/**
 * Keeps the deploy-window requests fresh (deployApprovalsStore.ts) and pops
 * a system notification when a new one starts waiting. Mounted once, next to
 * the Inbox listener; separate from it — these come from the console, not
 * from a computer's daemon. A notification click opens that request's card
 * at once, over whatever is on screen (DeployRequestDialog, T68).
 */
import { useEffect } from "react";

import { DeployRequestDialog } from "../components/inbox/DeployRequestDialog";
import { useFeatureFlag } from "../hooks/useFeatureFlags";

import { newlyWaiting } from "./deployApprovals.logic";
import {
  focusDeployRequest,
  nextPollDelay,
  refreshDeployApprovals,
  setDeployApprovalsEnabled,
  useDeployApprovalsStore,
} from "./deployApprovalsStore";
import { showSystemNotification } from "../inbox/systemNotifications";

export function DeployApprovalsListener() {
  // Labs → "Deploy windows in the Inbox": off by default (Misha 13.11).
  const enabled = useFeatureFlag("deployApprovals");
  useEffect(() => {
    setDeployApprovalsEnabled(enabled);
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let running = false;

    const tick = async () => {
      if (disposed || running) return;
      running = true;
      const previous = useDeployApprovalsStore.getState().gate;
      const next = await refreshDeployApprovals().finally(() => {
        running = false;
      });
      if (disposed) return;
      if (next) {
        for (const request of newlyWaiting(previous, next)) {
          showSystemNotification({
            tag: `ops-gate:${request.id}`,
            kind: "agent.approval",
            title: `${request.kind === "critical" ? "Критичное: " : ""}${request.machine || "Машина"} просит окно в прод`,
            body: `${request.summary} · ${request.minutes} мин`,
            viewingItsChat: false,
            onClick: () => focusDeployRequest(request),
          });
        }
      }
      schedule();
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (disposed) return;
      const state = useDeployApprovalsStore.getState();
      if (state.stopped) return;
      timer = setTimeout(
        () => void tick(),
        nextPollDelay({
          visible: document.visibilityState === "visible",
          nowMs: Date.now(),
          fastUntil: state.fastUntil,
        }),
      );
    };

    // Back from the browser's Touch ID page, or the window shown again: ask now.
    const now = () => {
      if (document.visibilityState !== "visible" || running) return;
      if (useDeployApprovalsStore.getState().stopped) return;
      void tick();
    };
    // "Открыть" was pressed: poll fast from now on, not from the next tick.
    const unsubscribe = useDeployApprovalsStore.subscribe((state, prev) => {
      if (state.fastUntil > prev.fastUntil && !running) schedule();
    });

    void tick();
    window.addEventListener("focus", now);
    document.addEventListener("visibilitychange", now);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", now);
      document.removeEventListener("visibilitychange", now);
    };
  }, [enabled]);

  return enabled ? <DeployRequestDialog /> : null;
}
