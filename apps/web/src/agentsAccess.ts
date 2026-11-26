import type {
  EnvironmentId,
  ThreadController,
  ThreadHandlerComputer,
  ThreadHandlerKind,
  ThreadId,
} from "@t3tools/contracts";

import { AGENTS_ACCESS_COPY, HANDLER_COPY } from "./agentThreads.logic";
import { readEnvironmentApi } from "./environmentApi";
import { HAND_TO_COPY } from "./handTo.logic";
import { newCommandId } from "./lib/utils";
import { stackedThreadToast, toastManager } from "./components/ui/toast";

/**
 * "Don't let agents write here" / "Let agents write here" for one chat: the
 * person's switch, stored as `agentsClosedAt` in the chat's events (it
 * survives restarts). Shared by the chat menu and the strip above the
 * composer. Resolves true when the daemon took it.
 */
export async function setThreadAgentsClosed(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly closed: boolean;
}): Promise<boolean> {
  const api = readEnvironmentApi(input.environmentId);
  if (!api) return false;
  try {
    await api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId: input.threadId,
      agentsClosedAt: input.closed ? new Date().toISOString() : null,
    });
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: input.closed ? AGENTS_ACCESS_COPY.closedToast : AGENTS_ACCESS_COPY.openedToast,
      }),
    );
    return true;
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: AGENTS_ACCESS_COPY.failed,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
    return false;
  }
}

/**
 * Join a chat an agent handles, or hand one to its agent (Misha 14.11): who
 * handles it is its `controller` (thread.control.set). Joining puts it in the
 * person's sidebar; handing it off moves it under "Agents' chats". Shared by
 * the Tasks strip, the strip above the composer and the chat menu. Resolves
 * true when the daemon took it.
 */
export async function setThreadHandler(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly controller: ThreadController;
}): Promise<boolean> {
  const api = readEnvironmentApi(input.environmentId);
  if (!api) return false;
  try {
    await api.orchestration.dispatchCommand({
      type: "thread.control.set",
      commandId: newCommandId(),
      threadId: input.threadId,
      controller: input.controller,
      createdAt: new Date().toISOString(),
    });
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: input.controller === "human" ? HANDLER_COPY.joinedToast : HANDLER_COPY.handedToast,
      }),
    );
    return true;
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: HANDLER_COPY.failed,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
    return false;
  }
}

/**
 * "Hand to…" / "Take back" (T63, Misha 24.11): hand the chat to another chat
 * or an assistant (thread.handler.set), or take it back (handler null). The
 * handler gets a brief and then this chat's Ready and questions; approvals
 * stay with the person. Resolves true when the daemon took it.
 */
export async function setThreadHandedTo(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly handler: {
    readonly threadId: ThreadId;
    readonly kind: ThreadHandlerKind;
    readonly title: string;
    readonly note?: string | null;
    /** On another of the person's computers (T63-C). */
    readonly computer?: ThreadHandlerComputer | null;
  } | null;
}): Promise<boolean> {
  const api = readEnvironmentApi(input.environmentId);
  if (!api) return false;
  const { handler } = input;
  try {
    await api.orchestration.dispatchCommand({
      type: "thread.handler.set",
      commandId: newCommandId(),
      threadId: input.threadId,
      handler:
        handler === null
          ? null
          : {
              threadId: handler.threadId,
              kind: handler.kind,
              title: handler.title,
              note: handler.note?.trim() ? handler.note.trim() : null,
              ...(handler.computer ? { computer: handler.computer } : {}),
            },
      ...(handler === null ? { reason: "taken-back" as const } : {}),
      createdAt: new Date().toISOString(),
    });
    toastManager.add(
      stackedThreadToast(
        handler === null
          ? { type: "success", title: HAND_TO_COPY.takenBackToast }
          : {
              type: "success",
              title: HAND_TO_COPY.handedToast(handler.title, handler.computer?.name),
              description: HAND_TO_COPY.handedDescription,
            },
      ),
    );
    return true;
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: HAND_TO_COPY.failed,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
    return false;
  }
}
