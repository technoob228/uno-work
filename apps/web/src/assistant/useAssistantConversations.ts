/**
 * The assistant's conversations on the computer the app is looking at
 * (0.0.85): the main one (Telegram / Slack talk to it) and the others,
 * started with "New conversation" — one Uno, one memory, many chats.
 */
import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { listAssistantConversations } from "@t3tools/shared/assistantChat";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useEnvironmentSupportsAssistantConversations } from "../environments/assistantChatSupport";
import { useActiveMachine } from "../hooks/useActiveMachine";
import { createAssistantConversation } from "../lib/managerApi";
import { selectSidebarThreadsForEnvironment, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";
import { toastManager } from "../components/ui/toast";

export interface AssistantConversationsState {
  readonly environmentId: EnvironmentId | null;
  /** Live, unarchived conversations: the main one first, then the one used last. */
  readonly conversations: ReadonlyArray<SidebarThreadSummary>;
  /** The daemon can start more conversations (0.0.85+). */
  readonly supported: boolean;
  readonly creating: boolean;
  readonly createConversation: () => Promise<void>;
  readonly openConversation: (threadId: ThreadId) => Promise<void>;
}

export function useAssistantConversations(): AssistantConversationsState {
  const { environmentId } = useActiveMachine();
  const supported = useEnvironmentSupportsAssistantConversations(environmentId);
  const threads = useStore(
    useShallow((store) => selectSidebarThreadsForEnvironment(store, environmentId)),
  );
  const conversations = useMemo(() => listAssistantConversations(threads), [threads]);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  const openConversation = useCallback(
    async (threadId: ThreadId) => {
      if (environmentId === null) return;
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId }),
      });
    },
    [environmentId, navigate],
  );

  const createConversation = useCallback(async () => {
    if (environmentId === null || !supported) return;
    setCreating(true);
    try {
      const { threadId } = await createAssistantConversation({ environmentId });
      await openConversation(threadId);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't start a conversation with Uno",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCreating(false);
    }
  }, [environmentId, openConversation, supported]);

  return {
    environmentId,
    conversations,
    supported,
    creating,
    createConversation,
    openConversation,
  };
}
