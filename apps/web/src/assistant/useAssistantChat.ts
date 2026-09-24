/**
 * THE assistant chat ("Uno") of the computer the app is looking at: which
 * chat it is, and how to open it. Opening never dead-ends: the marked chat;
 * else the daemon sets one up now (the same migration it runs on start);
 * on a daemon too old for that, a new chat in the assistant's workspace;
 * with no assistant at all, its settings.
 */
import { scopeProjectRef } from "@t3tools/client-runtime";
import { ASSISTANT_PROJECT_ID, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useEnvironmentSupportsAssistantChat } from "../environments/assistantChatSupport";
import { useActiveMachine } from "../hooks/useActiveMachine";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { ensureAssistantChat } from "../lib/managerApi";
import {
  selectProjectsForEnvironment,
  selectSidebarThreadsForEnvironment,
  useStore,
} from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";
import { findAssistantChat } from "./assistantChat.logic";

export interface AssistantChatState {
  readonly environmentId: EnvironmentId | null;
  readonly chat: SidebarThreadSummary | null;
  /** The computer has an assistant workspace at all. */
  readonly hasAssistant: boolean;
  readonly opening: boolean;
  readonly open: () => Promise<void>;
}

export function useAssistantChat(): AssistantChatState {
  const { environmentId } = useActiveMachine();
  const daemonMarksChat = useEnvironmentSupportsAssistantChat(environmentId);
  const threads = useStore(
    useShallow((store) => selectSidebarThreadsForEnvironment(store, environmentId)),
  );
  const hasAssistant = useStore((store) =>
    selectProjectsForEnvironment(store, environmentId).some(
      (project) => project.id === ASSISTANT_PROJECT_ID,
    ),
  );
  const chat = useMemo(
    () => findAssistantChat(threads, { daemonMarksChat }),
    [daemonMarksChat, threads],
  );
  const navigate = useNavigate();
  const { handleNewThread } = useNewThreadHandler();
  const [opening, setOpening] = useState(false);

  const goToThread = useCallback(
    (env: EnvironmentId, threadId: ThreadId) =>
      navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId: env, threadId }),
      }),
    [navigate],
  );

  const open = useCallback(async () => {
    if (environmentId === null) return;
    if (chat !== null) {
      await goToThread(environmentId, chat.id);
      return;
    }
    setOpening(true);
    try {
      if (daemonMarksChat) {
        const result = await ensureAssistantChat({ environmentId }).catch(() => null);
        if (result) {
          await goToThread(environmentId, result.threadId);
          return;
        }
      }
      if (hasAssistant) {
        await handleNewThread(scopeProjectRef(environmentId, ASSISTANT_PROJECT_ID), {
          envMode: "local",
        });
        return;
      }
      await navigate({
        to: "/settings/environment/$environmentId/assistants",
        params: { environmentId },
      });
    } finally {
      setOpening(false);
    }
  }, [chat, daemonMarksChat, environmentId, goToThread, handleNewThread, hasAssistant, navigate]);

  return { environmentId, chat, hasAssistant, opening, open };
}
