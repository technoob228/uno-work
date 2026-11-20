/**
 * Keeps the chat requests from the cloud fresh (chatRequestsStore.ts) — every
 * 5 s while the app is open, at once when the window comes back — and pops a
 * system notification once per request that starts waiting. Mounted once,
 * next to the Inbox listener. On a cloud computer it asks nothing.
 */
import { useEffect } from "react";

import { showSystemNotification } from "../inbox/systemNotifications";
import { useNavStore } from "../navigation/navStore";
import { newlyWaiting, requestTitle } from "./chatRequests.logic";
import {
  CHAT_REQUESTS_POLL_MS,
  openChatRequestBrief,
  refreshChatRequests,
  setChatRequestsHost,
  useChatRequestsHostId,
  useChatRequestsStore,
} from "./chatRequestsStore";

export function ChatRequestsListener() {
  const hostId = useChatRequestsHostId();
  useEffect(() => {
    setChatRequestsHost(hostId);
    if (!hostId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let running = false;

    const tick = async () => {
      if (disposed || running) return;
      running = true;
      const previous = useChatRequestsStore.getState().state;
      const next = await refreshChatRequests().finally(() => {
        running = false;
      });
      if (disposed) return;
      if (next) {
        for (const request of newlyWaiting(previous, next)) {
          showSystemNotification({
            tag: `chat-request:${request.id}`,
            // Needs the person: it shows even with the window in front.
            kind: "agent.input",
            title: requestTitle(request),
            body: request.gist,
            viewingItsChat: false,
            onClick: () => {
              useNavStore.getState().setSidebarMode("inbox");
              openChatRequestBrief(request.id);
            },
          });
        }
      }
      schedule();
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (disposed) return;
      timer = setTimeout(() => void tick(), CHAT_REQUESTS_POLL_MS);
    };

    const now = () => {
      if (document.visibilityState !== "visible" || running) return;
      void tick();
    };

    void tick();
    window.addEventListener("focus", now);
    document.addEventListener("visibilitychange", now);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", now);
      document.removeEventListener("visibilitychange", now);
    };
  }, [hostId]);

  return null;
}
