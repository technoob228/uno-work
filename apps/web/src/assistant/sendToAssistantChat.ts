/**
 * Send a message into THE Uno chat of a computer (the pinned "Uno"), as if
 * the person typed it there: the chat the daemon marks, set up now when the
 * computer has none yet. Used when a conversation moves to a new computer
 * (Uno AI → "Create my computer"): the teammate on the computer continues
 * it in its own chat, not in a new one next to it.
 *
 * Resolves to the chat's id once the message is accepted, null when there is
 * no Uno chat to send to (an older daemon) — the caller falls back.
 */
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";

import { readEnvironmentApi } from "../environmentApi";
import { ensureAssistantChat } from "../lib/managerApi";
import { newCommandId, newMessageId } from "../lib/utils";
import {
  selectEnvironmentState,
  selectSidebarThreadsForEnvironment,
  useStore,
} from "../store";
import { ensureAssistantChatWhenReady, findAssistantChat } from "./assistantChat.logic";
import { waitForThreadInStore } from "./useAssistantChat";

/** A fresh computer may still be setting its Uno up. */
const SETUP_WAIT_MS = 60_000;
const SETUP_RETRY_MS = 2_000;
const ARRIVAL_WAIT_MS = 5_000;

export async function sendToAssistantChat(input: {
  readonly environmentId: EnvironmentId;
  readonly text: string;
  /** The daemon marks its Uno chat (`useEnvironmentSupportsAssistantChat`). */
  readonly daemonMarksChat: boolean;
}): Promise<ThreadId | null> {
  const { environmentId } = input;
  const api = readEnvironmentApi(environmentId);
  if (!api || !input.daemonMarksChat) return null;

  const known = findAssistantChat(
    selectSidebarThreadsForEnvironment(useStore.getState(), environmentId),
    { daemonMarksChat: true },
  );
  let threadId: ThreadId | null = known?.id ?? null;
  if (threadId === null) {
    const ensured = await ensureAssistantChatWhenReady(
      () => ensureAssistantChat({ environmentId }),
      { waitMs: SETUP_WAIT_MS, retryMs: SETUP_RETRY_MS },
    );
    if (!ensured) return null;
    threadId = ensured.threadId;
  }
  await waitForThreadInStore(environmentId, threadId, ARRIVAL_WAIT_MS);

  const shell = selectEnvironmentState(useStore.getState(), environmentId).threadShellById[
    threadId
  ];
  await api.orchestration.dispatchCommand({
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId,
    message: {
      messageId: newMessageId(),
      role: "user",
      text: input.text,
      attachments: [],
    },
    ...(shell?.modelSelection ? { modelSelection: shell.modelSelection } : {}),
    runtimeMode: shell?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: shell?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: new Date().toISOString(),
  });
  return threadId;
}
