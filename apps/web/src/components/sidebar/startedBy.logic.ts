/**
 * Chats an assistant started (Misha 28.10, variant D p.5): they sit in the
 * common list of chats with "started by <name>", and one filter hides them.
 *
 * Who started a chat comes from its computer's daemon
 * (`GET /api/manager/started-by`): an assistant of that computer, or one on
 * another computer of the account. An older daemon doesn't know the route —
 * then the store tells what it can: a chat whose `spawnedByThreadId` chain
 * leads into a conversation with an assistant (a chat in its `assistant-…`
 * folder) was started by that assistant; a chat the daemon marks `spawned`
 * with no parent was started by that computer's Uno.
 *
 * Pure.
 */
import {
  ASSISTANT_PROJECT_ID,
  type ManagerStartedByEntry,
  isAssistantProjectId,
} from "@t3tools/contracts";

import { isTeamConversation } from "../assistants/assistantTeam.logic";

export interface StartedBy {
  /** The assistant's name as the person knows it ("Uno", "Mia"). */
  readonly name: string;
  /** Its folder on its computer (`assistant-…`); null when unknown. */
  readonly projectId: string | null;
  /** Its computer, when it is the chat's own; null — another computer. */
  readonly environmentId: string | null;
  readonly isUno: boolean;
  /** The other computer it lives on (`local: false`); null — the chat's own. */
  readonly fromComputer: string | null;
}

export interface StartedByThread {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly archivedAt: string | null;
  readonly spawnedByThreadId?: string | null | undefined;
  readonly assistantRole?: "chat" | "spawned" | null | undefined;
}

export type StartedByEntry = Pick<
  ManagerStartedByEntry,
  "threadId" | "assistantName" | "assistantProjectId" | "local" | "fromComputerName"
>;

/** The key of a chat across computers. */
export const startedByKey = (environmentId: string, threadId: string) =>
  `${environmentId}\u0000${threadId}`;

/** The chain of agents up to an assistant's conversation, if there is one. */
function viaChain<T extends StartedByThread>(
  thread: T,
  byId: ReadonlyMap<string, T>,
): { readonly projectId: string } | null {
  if (isTeamConversation(thread)) return null;
  const seen = new Set<string>([thread.id]);
  let current: T = thread;
  for (;;) {
    const parentId = current.spawnedByThreadId ?? null;
    if (parentId === null) {
      // The daemon marks the chats its Uno started (create_thread).
      return current.assistantRole === "spawned" ? { projectId: ASSISTANT_PROJECT_ID } : null;
    }
    if (seen.has(parentId)) return null;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) return null;
    if (isAssistantProjectId(parent.projectId) && isTeamConversation(parent)) {
      return { projectId: parent.projectId };
    }
    current = parent;
  }
}

/**
 * Who started each live chat, by `startedByKey`. `entries` holds what each
 * computer's daemon said; a computer missing from it (older daemon, no answer
 * yet) is read from the store. A chat the daemon doesn't list yet (just made)
 * falls back to the store too.
 */
export function resolveStartedBy<T extends StartedByThread>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly entries: ReadonlyMap<string, ReadonlyArray<StartedByEntry>>;
  /** The assistant's name on that computer; null — not known there. */
  readonly assistantName: (environmentId: string, projectId: string) => string | null;
}): ReadonlyMap<string, StartedBy> {
  const byEnvironment = new Map<string, Map<string, T>>();
  for (const thread of input.threads) {
    const map = byEnvironment.get(thread.environmentId) ?? new Map<string, T>();
    map.set(thread.id, thread);
    byEnvironment.set(thread.environmentId, map);
  }
  const listed = new Map<string, StartedByEntry>();
  for (const [environmentId, list] of input.entries) {
    for (const entry of list) listed.set(startedByKey(environmentId, entry.threadId), entry);
  }
  const result = new Map<string, StartedBy>();
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    const key = startedByKey(thread.environmentId, thread.id);
    const entry = listed.get(key);
    if (entry) {
      const projectId = entry.assistantProjectId;
      result.set(key, {
        name: entry.assistantName,
        projectId,
        environmentId: entry.local ? thread.environmentId : null,
        isUno: projectId === ASSISTANT_PROJECT_ID,
        fromComputer: entry.local ? null : (entry.fromComputerName ?? "another computer"),
      });
      continue;
    }
    const found = viaChain(thread, byEnvironment.get(thread.environmentId)!);
    if (!found) continue;
    const isUno = found.projectId === ASSISTANT_PROJECT_ID;
    result.set(key, {
      name:
        input.assistantName(thread.environmentId, found.projectId) ??
        (isUno ? "Uno" : "an assistant"),
      projectId: found.projectId,
      environmentId: thread.environmentId,
      isUno,
      fromComputer: null,
    });
  }
  return result;
}

/** "Started by Mia", "Started by Uno · from stage-work". */
export function startedByLabel(startedBy: StartedBy): string {
  return startedBy.fromComputer
    ? `Started by ${startedBy.name} · from ${startedBy.fromComputer}`
    : `Started by ${startedBy.name}`;
}

/**
 * Chats assistants started on the other computers, for a sidebar that lists
 * one computer only (the default): those still show, with their computer
 * (audit 27.10 line 9). With every computer in view there is nothing to add.
 */
export function startedByElsewhere<T extends StartedByThread>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly startedBy: ReadonlyMap<string, StartedBy>;
  /** The computer in view; null — all of them are. */
  readonly inView: string | null;
}): ReadonlyArray<T> {
  if (input.inView === null) return [];
  return input.threads.filter(
    (thread) =>
      thread.environmentId !== input.inView &&
      thread.archivedAt === null &&
      input.startedBy.has(startedByKey(thread.environmentId, thread.id)),
  );
}
