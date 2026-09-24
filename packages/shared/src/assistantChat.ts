/**
 * THE assistant chat ("Uno"): one pinned chat per computer. The assistant is
 * a property of the chat (`assistantRole: "chat"`), not a project the person
 * has to know about. Shared by the daemon (which marks the chat once — the
 * assistant-chat migration) and by clients (which find it, and fall back to
 * the same pick on a daemon that predates the marker).
 *
 * Pure: no I/O, no Effect — both sides feed it what they already hold.
 */

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
