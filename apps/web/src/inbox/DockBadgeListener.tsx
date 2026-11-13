import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";

import { countChatsWaitingOnYou } from "../components/Sidebar.yourTurn";
import { useDeployWaitingCount } from "../deployApprovals/deployApprovalsStore";
import { useMinuteClock } from "../hooks/useMinuteClock";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../store";

/**
 * The desktop app's Dock icon shows how many chats wait on the person
 * (approvals, questions, finished chats not answered or marked Done), so a
 * chat that finished while they were away is visible without opening the app.
 * Deploy-window requests waiting for a decision count too (13.11).
 */
export function DockBadgeListener() {
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const now = useMinuteClock();
  const count = countChatsWaitingOnYou(threads, now) + useDeployWaitingCount();
  useEffect(() => {
    void window.desktopBridge?.setBadgeCount?.(count).catch(() => undefined);
  }, [count]);
  return null;
}
