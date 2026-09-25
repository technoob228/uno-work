/**
 * THE assistant chat ("Uno"): one pinned chat per computer. The assistant is
 * a property of the chat (`assistantRole: "chat"`), not a project the person
 * has to know about. Shared by the daemon (which marks the chat once — the
 * assistant-chat migration) and by clients (which find it, and fall back to
 * the same pick on a daemon that predates the marker).
 *
 * Pure: no I/O, no Effect — both sides feed it what they already hold.
 */

import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";

export type AssistantRole = "chat" | "spawned";

export interface AssistantChatCandidate {
  readonly id: string;
  readonly projectId: string;
  readonly assistantRole?: AssistantRole | null | undefined;
  readonly archivedAt: string | null;
  readonly deletedAt?: string | null | undefined;
  readonly createdAt: string;
  readonly updatedAt?: string | undefined;
  readonly latestUserMessageAt?: string | null | undefined;
  /** Set on a chat another chat's agent started (agent-threads bridge). */
  readonly spawnedByThreadId?: string | null | undefined;
}

function isLive(thread: AssistantChatCandidate): boolean {
  return thread.deletedAt === null || thread.deletedAt === undefined;
}

/** When the person last talked in the chat: their last message, else the last change. */
function lastUsedAt(thread: AssistantChatCandidate): number {
  for (const value of [thread.latestUserMessageAt, thread.updatedAt, thread.createdAt]) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

/** The chat already marked as the assistant chat, if any (a live one). */
export function findMarkedAssistantChat<T extends AssistantChatCandidate>(
  threads: ReadonlyArray<T>,
): T | null {
  return threads.find((thread) => isLive(thread) && thread.assistantRole === "chat") ?? null;
}

/**
 * Which existing chat becomes the assistant chat when none is marked yet: a
 * live chat of the default assistant project, the one used last, active
 * before archived. Chats in `excludedThreadIds` (a Telegram / Slack chat's
 * own thread — a group chat must not become the person's private assistant
 * chat) never qualify. Null: nothing to migrate, start a fresh chat.
 */
export function pickAssistantChatToMigrate<T extends AssistantChatCandidate>(
  threads: ReadonlyArray<T>,
  input: {
    readonly assistantProjectId: string;
    readonly excludedThreadIds?: ReadonlySet<string>;
  },
): T | null {
  const excluded = input.excludedThreadIds ?? new Set<string>();
  const candidates = threads.filter(
    (thread) =>
      isLive(thread) &&
      thread.projectId === input.assistantProjectId &&
      thread.assistantRole !== "spawned" &&
      !excluded.has(thread.id),
  );
  const ranked = candidates.toSorted(
    (a, b) =>
      Number(a.archivedAt !== null) - Number(b.archivedAt !== null) ||
      lastUsedAt(b) - lastUsedAt(a) ||
      a.id.localeCompare(b.id),
  );
  return ranked[0] ?? null;
}

/**
 * The assistant chat as a client sees it: the marked one; on a daemon that
 * cannot mark chats yet (`daemonMarksChat` false), the same pick the
 * migration would make. Null when there is none (yet).
 */
export function resolveAssistantChat<T extends AssistantChatCandidate>(
  threads: ReadonlyArray<T>,
  input: { readonly assistantProjectId: string; readonly daemonMarksChat: boolean },
): T | null {
  const marked = findMarkedAssistantChat(threads);
  if (marked !== null) return marked;
  if (input.daemonMarksChat) return null;
  return pickAssistantChatToMigrate(threads, { assistantProjectId: input.assistantProjectId });
}

/**
 * A conversation with the assistant ("Uno", 0.0.85): the main chat (the one
 * marked `assistantRole: "chat"`, which Telegram / Slack talk to) and every
 * other chat in the assistant's own workspace — "New conversation" and a
 * Telegram / Slack chat's own thread among them. They all share the
 * assistant's memory (AGENTS.md / NOTES.md in that workspace) and all run on
 * the assistant's engine (Hermes). Chats the assistant started in other
 * projects (`spawned`) and chats an agent started through the agent-threads
 * bridge (`spawnedByThreadId`, possibly in the assistant's own folder) are
 * work chats on the harness they were started with, not conversations.
 */
export function isAssistantConversation(
  thread: Pick<AssistantChatCandidate, "projectId" | "assistantRole" | "spawnedByThreadId">,
): boolean {
  if (thread.assistantRole === "chat") return true;
  return (
    thread.projectId === ASSISTANT_PROJECT_ID &&
    thread.assistantRole !== "spawned" &&
    (thread.spawnedByThreadId ?? null) === null
  );
}

/**
 * The assistant's conversations as the sidebar lists them: live and not
 * archived, the main one first, then the one used last.
 */
export function listAssistantConversations<T extends AssistantChatCandidate>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return threads
    .filter(
      (thread) => isLive(thread) && thread.archivedAt === null && isAssistantConversation(thread),
    )
    .toSorted(
      (a, b) =>
        Number(b.assistantRole === "chat") - Number(a.assistantRole === "chat") ||
        lastUsedAt(b) - lastUsedAt(a) ||
        a.id.localeCompare(b.id),
    );
}
