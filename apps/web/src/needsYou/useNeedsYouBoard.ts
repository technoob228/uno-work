import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useMinuteClock } from "../hooks/useMinuteClock";
import { skippedQuestionThreadKeys } from "../inbox/inboxActions.logic";
import { useInboxEntries } from "../inbox/inboxStore";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../store";
import { useExternalAsksStore } from "./externalAsks";
import { buildNeedsYouBoard, type NeedsYouBoard } from "./needsYou.logic";

/** The Needs-you board from every connected computer's chats + the tracker's asks. */
export function useNeedsYouBoard(): NeedsYouBoard {
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const inbox = useInboxEntries();
  const asks = useExternalAsksStore((state) => state.asks);
  const answered = useExternalAsksStore((state) => state.answered);
  const clock = useMinuteClock();
  return useMemo(() => {
    const nowMs = Math.max(Date.parse(clock), Date.now());
    return buildNeedsYouBoard({
      threads,
      asks,
      answered,
      skippedQuestions: skippedQuestionThreadKeys(inbox, nowMs),
      now: new Date(nowMs).toISOString(),
    });
  }, [threads, inbox, asks, answered, clock]);
}

/** The one count: the sidebar's Needs you and the screen's verdict agree. */
export function useNeedsYouCount(): number {
  return useNeedsYouBoard().count;
}
