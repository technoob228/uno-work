/**
 * "Hand to…" (T63, Misha 24.11) in the browser: who may handle a chat, in
 * the order the picker shows them, and the open picker itself.
 *
 * The same rules as the daemon (apps/server/src/orchestration/threadHandler.ts)
 * so the picker never offers a chat the daemon would refuse: not the chat
 * itself, not a chat it started, not a chat it handles (A → B → A), not an
 * archived one, and the chain stays at most THREAD_HANDLER_MAX_DEPTH deep.
 */
import {
  THREAD_HANDLER_MAX_DEPTH,
  type EnvironmentId,
  type ThreadHandlerKind,
  type ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";

export interface HandToThreadView {
  readonly id: ThreadId;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt?: string | undefined;
  readonly archivedAt: string | null;
  readonly pinnedAt?: string | null | undefined;
  readonly spawnedByThreadId?: ThreadId | null | undefined;
  readonly handler?: { readonly threadId: ThreadId } | null | undefined;
  readonly assistantRole?: string | null | undefined;
}

export interface HandToOption {
  readonly threadId: ThreadId;
  readonly kind: ThreadHandlerKind;
  readonly title: string;
  readonly detail: string;
}

export interface HandToOptions {
  readonly coordinators: ReadonlyArray<HandToOption>;
  readonly assistants: ReadonlyArray<HandToOption>;
  readonly others: ReadonlyArray<HandToOption>;
}

const hopsAbove = (byId: ReadonlyMap<string, HandToThreadView>, id: string): number => {
  const seen = new Set<string>([id]);
  let hops = 0;
  let current = byId.get(id)?.handler?.threadId ?? null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    hops += 1;
    current = byId.get(current)?.handler?.threadId ?? null;
  }
  return hops;
};

const hopsBelow = (threads: ReadonlyArray<HandToThreadView>, id: string): number => {
  const handledBy = new Map<string, Array<string>>();
  for (const thread of threads) {
    const handler = thread.handler?.threadId;
    if (handler === undefined) continue;
    handledBy.set(handler, [...(handledBy.get(handler) ?? []), thread.id]);
  }
  const walk = (at: string, seen: ReadonlySet<string>): number => {
    let deepest = 0;
    for (const child of handledBy.get(at) ?? []) {
      if (seen.has(child)) continue;
      deepest = Math.max(deepest, 1 + walk(child, new Set([...seen, child])));
    }
    return deepest;
  };
  return walk(id, new Set([id]));
};

const walksTo = (
  byId: ReadonlyMap<string, HandToThreadView>,
  from: string | null | undefined,
  step: (thread: HandToThreadView) => string | null | undefined,
  target: string,
): boolean => {
  const seen = new Set<string>();
  let current = from ?? null;
  while (current !== null && !seen.has(current)) {
    if (current === target) return true;
    seen.add(current);
    const thread = byId.get(current);
    current = thread ? (step(thread) ?? null) : null;
  }
  return false;
};

/** Whether the daemon would take `candidate` as the handler of `threadId`. */
export function canHandle(
  threads: ReadonlyArray<HandToThreadView>,
  threadId: ThreadId,
  candidate: HandToThreadView,
): boolean {
  if (candidate.id === threadId || candidate.archivedAt !== null) return false;
  const byId = new Map(threads.map((thread) => [thread.id as string, thread] as const));
  // Started by this chat (any depth down): it would report to its own worker.
  if (walksTo(byId, candidate.spawnedByThreadId, (t) => t.spawnedByThreadId, threadId)) {
    return false;
  }
  // Handled (through its handlers) by this chat: A → B → A.
  if (walksTo(byId, candidate.id, (t) => t.handler?.threadId, threadId)) return false;
  return (
    hopsBelow(threads, threadId) + 1 + hopsAbove(byId, candidate.id) <= THREAD_HANDLER_MAX_DEPTH
  );
}

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/**
 * The picker's groups: coordinators (chats that run chats, the most first,
 * pinned above), assistants, the two latest other chats — a search shows
 * up to 12 of each.
 */
export function handToOptions(input: {
  readonly threads: ReadonlyArray<HandToThreadView>;
  readonly threadId: ThreadId;
  readonly query: string;
}): HandToOptions {
  const { threads, threadId } = input;
  const needle = input.query.trim().toLowerCase();
  const match = (title: string) => needle.length === 0 || title.toLowerCase().includes(needle);
  const limit = needle.length > 0 ? 12 : 2;
  const children = new Map<string, number>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || !thread.spawnedByThreadId) continue;
    children.set(thread.spawnedByThreadId, (children.get(thread.spawnedByThreadId) ?? 0) + 1);
  }
  const fit = threads.filter(
    (thread) => match(thread.title) && canHandle(threads, threadId, thread),
  );
  const latest = (thread: HandToThreadView) => thread.updatedAt ?? thread.createdAt;

  const assistants = fit
    .filter((thread) => thread.assistantRole === "chat")
    .map((thread) => ({
      threadId: thread.id,
      kind: "assistant" as const,
      title: thread.title,
      detail: "Assistant",
    }));
  const coordinators = fit
    .filter((thread) => thread.assistantRole !== "chat" && (children.get(thread.id) ?? 0) > 0)
    .toSorted(
      (a, b) =>
        Number(b.pinnedAt != null) - Number(a.pinnedAt != null) ||
        (children.get(b.id) ?? 0) - (children.get(a.id) ?? 0) ||
        latest(b).localeCompare(latest(a)),
    )
    .slice(0, needle.length > 0 ? 12 : 4)
    .map((thread) => ({
      threadId: thread.id,
      kind: "chat" as const,
      title: thread.title,
      detail: `Coordinator · runs ${plural(children.get(thread.id) ?? 0, "chat")}`,
    }));
  const others = fit
    .filter(
      (thread) =>
        thread.assistantRole !== "chat" &&
        (children.get(thread.id) ?? 0) === 0 &&
        // A chat an agent started is its worker, not someone to hand work to.
        !thread.spawnedByThreadId,
    )
    .toSorted((a, b) => latest(b).localeCompare(latest(a)))
    .slice(0, limit)
    .map((thread) => ({
      threadId: thread.id,
      kind: "chat" as const,
      title: thread.title,
      detail: "Chat",
    }));
  return { coordinators, assistants, others };
}

/** The open "Hand to…" picker (one at a time, from the chat menu or the chip). */
export interface HandToTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
}

export const useHandToStore = create<{
  readonly target: HandToTarget | null;
  readonly open: (target: HandToTarget) => void;
  readonly close: () => void;
}>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));

export const HAND_TO_COPY = {
  action: "Hand to…",
  takeBack: "Take back",
  ownAgent: "Its own agent",
  ownAgentDetail: "Carries on by itself · you see only Needs you and the result",
  handedToast: (title: string) => `Handed to “${title}”`,
  handedDescription: "It moved under them in the sidebar · Take back any time",
  takenBackToast: "It's your chat again",
  failed: "Could not hand this chat over",
} as const;
