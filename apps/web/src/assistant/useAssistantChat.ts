/**
 * THE assistant chat ("Uno") of the computer the app is looking at: which
 * chat it is, and how to open it. Opening never dead-ends: the marked chat;
 * else the daemon sets one up now (the same migration it runs on start);
 * on a daemon too old for that, a new chat in the assistant's workspace;
 * with no assistant at all, its settings.
 *
 * A computer that has just started may still be setting its assistant up:
 * opening then keeps asking for a while ("Getting ready…") rather than
 * sending the person to Settings, and waits for the chat to reach this
 * client before showing it (a route to a chat the client doesn't know yet
 * rendered an empty page with no message box).
 */
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
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
  selectThreadExistsByRef,
  useStore,
} from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";
import { ensureAssistantChatWhenReady, findAssistantChat } from "./assistantChat.logic";

/** How long to wait for a just-created chat to reach this client. */
const ASSISTANT_CHAT_ARRIVAL_WAIT_MS = 5_000;

/** Resolves once the thread is in the client store (or after `timeoutMs`). */
function waitForThreadInStore(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  timeoutMs: number,
): Promise<void> {
  const ref = scopeThreadRef(environmentId, threadId);
  if (selectThreadExistsByRef(useStore.getState(), ref)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const unsubscribe = useStore.subscribe((state) => {
      if (selectThreadExistsByRef(state, ref)) done();
    });
  });
}

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
        const result = await ensureAssistantChatWhenReady(() =>
          ensureAssistantChat({ environmentId }),
        );
        if (result) {
          await waitForThreadInStore(
            environmentId,
            result.threadId,
            ASSISTANT_CHAT_ARRIVAL_WAIT_MS,
          );
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
