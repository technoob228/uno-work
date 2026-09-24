/**
 * The assistant as one pinned chat ("Uno") — the pure parts the sidebar, the
 * chat header, Home and the bell share: which chat it is, which chats it
 * started ("from Uno"), what the chat list leaves out.
 */
import { ASSISTANT_PROJECT_ID, isAssistantProjectId } from "@t3tools/contracts";
import { resolveAssistantChat } from "@t3tools/shared/assistantChat";

import type {
  ManagerSlackConnectorStatus,
  ManagerTelegramConnectorStatus,
} from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../types";

/** What the pinned chat is called everywhere, whatever its stored title. */
export const ASSISTANT_CHAT_NAME = "Uno";

export function findAssistantChat<T extends SidebarThreadSummary>(
  threads: ReadonlyArray<T>,
  input: { readonly daemonMarksChat: boolean },
): T | null {
  return resolveAssistantChat(threads, {
    assistantProjectId: ASSISTANT_PROJECT_ID,
    daemonMarksChat: input.daemonMarksChat,
  });
}

/** A chat Uno started (manager `create_thread`, or its agent's bridge spawn). */
export function isFromAssistant(
  thread: Pick<SidebarThreadSummary, "assistantRole" | "spawnedByThreadId">,
  assistantChatId: string | null,
): boolean {
  if (thread.assistantRole === "spawned") return true;
  return assistantChatId !== null && thread.spawnedByThreadId === assistantChatId;
}

/**
 * Chats the main list shows: not the Uno chat itself (it is pinned on top),
 * and not the assistant's other chats — its older chats and the ones Telegram /
 * Slack chats talk through live behind the "Older Uno chats" filter.
 */
export function isRegularListChat(
  thread: Pick<SidebarThreadSummary, "id" | "projectId">,
  assistantChatId: string | null,
): boolean {
  if (assistantChatId !== null && thread.id === assistantChatId) return false;
  return !isAssistantProjectId(thread.projectId);
}

/** The assistant's other chats (older desktop chats, Telegram / Slack chats). */
export function isOlderAssistantChat(
  thread: Pick<SidebarThreadSummary, "id" | "projectId">,
  assistantChatId: string | null,
): boolean {
  return isAssistantProjectId(thread.projectId) && thread.id !== assistantChatId;
}

export type ChannelState = "off" | "on" | "problem";

/** Telegram as the Connect menu shows it: off, working, or needs a look. */
export function telegramChannelState(
  status: Pick<ManagerTelegramConnectorStatus, "configured" | "enabled" | "health" | "lastError">,
): ChannelState {
  if (!status.configured || !status.enabled) return "off";
  const health = status.health?.status ?? null;
  if (health === "auth_expired" || health === "delivery_failed") return "problem";
  if (health === null && status.lastError) return "problem";
  return "on";
}

/** Slack the same way (no health block: the last error is the signal). */
export function slackChannelState(
  status: Pick<ManagerSlackConnectorStatus, "configured" | "enabled" | "lastError">,
): ChannelState {
  if (!status.configured || !status.enabled) return "off";
  return status.lastError ? "problem" : "on";
}
