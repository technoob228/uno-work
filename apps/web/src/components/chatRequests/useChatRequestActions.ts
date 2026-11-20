/**
 * Start / Decline of a chat request from the cloud, the same from every
 * place that shows one (Needs you, the sidebar, the brief): Start opens the
 * chat the server started here; a failure shows the server's sentence.
 */
import { scopeThreadRef } from "@t3tools/client-runtime";
import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { waitForThreadInStore } from "../../assistant/useAssistantChat";
import { decideChatRequest } from "../../chatRequests/chatRequestsStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { toastManager } from "../ui/toast";

export function useChatRequestActions(options?: { readonly onDone?: () => void }) {
  const navigate = useNavigate();
  const onDone = options?.onDone;

  const start = useCallback(
    async (id: string) => {
      const outcome = await decideChatRequest(id, "start");
      if (!outcome.ok) {
        toastManager.add({
          type: "error",
          title: "The chat didn't start",
          description: outcome.message,
        });
        return;
      }
      onDone?.();
      if (outcome.threadId) {
        const threadId = ThreadId.make(outcome.threadId);
        // The chat reaches this window a moment after the answer: the route
        // would send an unknown chat back Home.
        await waitForThreadInStore(outcome.hostId, threadId, 5_000);
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(outcome.hostId, threadId)),
        });
      } else {
        toastManager.add({ type: "success", title: "The chat started" });
      }
    },
    [navigate, onDone],
  );

  const decline = useCallback(async (id: string) => {
    const outcome = await decideChatRequest(id, "decline");
    if (!outcome.ok) {
      toastManager.add({
        type: "error",
        title: "Couldn't decline",
        description: outcome.message,
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: "Declined",
      description: "The cloud chat is told no chat started here.",
    });
  }, []);

  return { start, decline };
}
