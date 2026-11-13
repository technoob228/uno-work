/**
 * Keeps the deploy-window requests fresh (deployApprovalsStore.ts) and pops
 * a system notification when a new one starts waiting. Mounted once, next to
 * the Inbox listener; separate from it — these come from the console, not
 * from a computer's daemon.
 */
import { useEffect } from "react";

import { useNavStore } from "../navigation/navStore";
import { newlyWaiting } from "./deployApprovals.logic";
import {
  nextPollDelay,
  refreshDeployApprovals,
  useDeployApprovalsStore,
} from "./deployApprovalsStore";
import { showSystemNotification } from "../inbox/systemNotifications";

/** A notification click: the sidebar's Inbox, where the card is. */
function openInbox(): void {
  useNavStore.getState().setSidebarMode("inbox");
}

export function DeployApprovalsListener() {
  useEffect(() => {
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
            title: `${request.machine || "Машина"} просит окно в прод`,
            body: `${request.summary} · ${request.minutes} мин`,
            viewingItsChat: false,
            onClick: openInbox,
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
  }, []);

  return null;
}
