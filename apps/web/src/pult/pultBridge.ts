/**
 * What the Pult asks of Uno Work — the prototype of the panel bridge methods
 * Work does not have yet: open an existing chat in the middle (`openThread`)
 * and write into an existing chat (`sendToThread`). Here they are direct calls,
 * because the Pult is a component of Work itself.
 */
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";

import { readEnvironmentApi } from "../environmentApi";
import { newCommandId, newMessageId } from "../lib/utils";
import type { PultThreadRef } from "./pult.types";

/** Route params for the chat (`/$environmentId/$threadId`). */
export function threadRouteParams(ref: PultThreadRef): { environmentId: EnvironmentId; threadId: ThreadId } {
  return { environmentId: ref.environmentId as EnvironmentId, threadId: ref.threadId as ThreadId };
}

/** Write `text` into the chat as the owner's message; the agent takes it on its next turn. */
export async function sendToThread(ref: PultThreadRef, text: string): Promise<boolean> {
  const api = readEnvironmentApi(ref.environmentId as EnvironmentId);
  if (!api) return false;
  await api.orchestration.dispatchCommand({
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId: ref.threadId as ThreadId,
    message: { messageId: newMessageId(), role: "user", text, attachments: [] },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: new Date().toISOString(),
  });
  return true;
}
