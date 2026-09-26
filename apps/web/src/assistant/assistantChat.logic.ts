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

/**
 * Telegram as the Connect menu shows it: off, working, or needs a look. A bot
 * no chat may write to yet (the link step isn't done) is not "on".
 */
export function telegramChannelState(
  status: Pick<
    ManagerTelegramConnectorStatus,
    "configured" | "enabled" | "health" | "lastError"
  > & {
    readonly allowedChatIds?: ReadonlyArray<string>;
  },
): ChannelState {
  if (!status.configured || !status.enabled) return "off";
  const health = status.health?.status ?? null;
  if (health === "auth_expired" || health === "delivery_failed") return "problem";
  if (health === null && status.lastError) return "problem";
  if (status.allowedChatIds !== undefined && status.allowedChatIds.length === 0) return "problem";
  return "on";
}

/** Slack the same way (no health block: the last error is the signal). */
export function slackChannelState(
  status: Pick<ManagerSlackConnectorStatus, "configured" | "enabled" | "lastError">,
): ChannelState {
  if (!status.configured || !status.enabled) return "off";
  return status.lastError ? "problem" : "on";
}

/** The one line that says what Uno is, wherever it introduces itself. */
export const ASSISTANT_VALUE_LINE =
  "Always on. Talks to you in Telegram or Slack, starts and watches other chats for you.";

/** Why Uno's harness is not a choice (header chip, Settings). */
export const ASSISTANT_HARNESS_NOTE =
  "Uno always runs on Hermes: it keeps Uno's memory and tools the same in every conversation, in Telegram and in Slack, and works with any model. Pick the model and where the AI comes from instead.";

/** How a conversation is named in the Uno list. */
export function assistantConversationLabel(
  thread: Pick<SidebarThreadSummary, "assistantRole" | "title">,
): string {
  if (thread.assistantRole === "chat") return "Main conversation";
  const title = thread.title.trim();
  return title.length > 0 ? title : "Conversation";
}

/** How many conversations the folded-out Uno row lists before "Show all". */
export const ASSISTANT_CONVERSATIONS_PREVIEW = 5;

/** How long opening keeps asking a computer that is still starting up. */
export const ASSISTANT_CHAT_READY_WAIT_MS = 20_000;
const ASSISTANT_CHAT_RETRY_MS = 1_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The daemon's answer for THE chat, asking again while it is still setting
 * the assistant up (the call fails until then). `null`: no chat within
 * `waitMs` — a real absence.
 */
export async function ensureAssistantChatWhenReady<T>(
  ensure: () => Promise<T>,
  options: {
    readonly waitMs?: number;
    readonly retryMs?: number;
    readonly now?: () => number;
    readonly wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<T | null> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? sleep;
  const deadline = now() + (options.waitMs ?? ASSISTANT_CHAT_READY_WAIT_MS);
  for (;;) {
    const result = await ensure().catch(() => null);
    if (result !== null) return result;
    if (now() >= deadline) return null;
    await wait(options.retryMs ?? ASSISTANT_CHAT_RETRY_MS);
  }
}
