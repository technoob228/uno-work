/**
 * "Hand to…" (T63, Misha 24.11) — the pure rules of who may handle a chat.
 *
 * The person hands a chat to another chat (a coordinator) or to an
 * assistant's conversation: the handler gets a brief, then this chat's Ready
 * and questions instead of the person (manager/Layers/AssistantPush.ts), and
 * may write here and answer with text. Approvals, secrets, payments and
 * sign-ins stay with the person.
 *
 * Refused (the decider maps a refusal to `<code>: <detail>`):
 * - `handler_self`        — the chat itself;
 * - `handler_subordinate` — a chat this chat started (directly or further
 *                            down): it would report to its own worker;
 * - `handler_missing`     — no such chat on this computer;
 * - `handler_archived`    — archived or deleted;
 * - `handler_loop`        — the handler is (through its own handlers) handled
 *                            by this chat: A → B → A;
 * - `handler_too_deep`    — the chain would be longer than
 *                            THREAD_HANDLER_MAX_DEPTH hops (A → B → C is fine);
 * - `handler_remote`      — the handler is itself handed to another computer
 *                            (T63-C): a chat handed across stays a leaf;
 * - `handler_remote_busy` — handing to another computer a chat that handles
 *                            chats itself (T63-C). With `handler_remote` a
 *                            loop can't cross computers, and the handler's
 *                            side counts the whole depth.
 *
 * @module orchestration/threadHandler
 */
import { THREAD_HANDLER_MAX_DEPTH, type ThreadHandler, type ThreadId } from "@t3tools/contracts";

export interface HandlerThreadView {
  readonly id: string;
  readonly spawnedByThreadId?: string | null | undefined;
  readonly handler?: Pick<ThreadHandler, "threadId" | "computer"> | null | undefined;
  readonly archivedAt?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
}

export type HandlerRefusalCode =
  | "handler_self"
  | "handler_subordinate"
  | "handler_missing"
  | "handler_archived"
  | "handler_loop"
  | "handler_too_deep"
  | "handler_remote"
  | "handler_remote_busy";

export interface HandlerRefusal {
  readonly code: HandlerRefusalCode;
  readonly detail: string;
}

/** Longest note / title kept on the chat (the brief carries the note). */
export const HANDLER_NOTE_MAX_CHARS = 1_000;
export const HANDLER_TITLE_MAX_CHARS = 200;

const byIdOf = (threads: ReadonlyArray<HandlerThreadView>) =>
  new Map(threads.map((thread) => [thread.id, thread] as const));

/** Hops from `threadId` up its handlers (0: nobody handles it). Cycles stop the walk. */
export function handlerHopsAbove(
  threads: ReadonlyArray<HandlerThreadView>,
  threadId: string,
): number {
  const byId = byIdOf(threads);
  const seen = new Set<string>([threadId]);
  let hops = 0;
  let current = byId.get(threadId)?.handler?.threadId ?? null;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    hops += 1;
    current = byId.get(current)?.handler?.threadId ?? null;
  }
  return hops;
}

/** The longest chain of chats handed (through each other) to `threadId`. */
export function handlerHopsBelow(
  threads: ReadonlyArray<HandlerThreadView>,
  threadId: string,
): number {
  const handledBy = new Map<string, Array<string>>();
  for (const thread of threads) {
    const handler = thread.handler?.threadId;
    if (handler === undefined) continue;
    handledBy.set(handler, [...(handledBy.get(handler) ?? []), thread.id]);
  }
  const walk = (id: string, seen: ReadonlySet<string>): number => {
    let deepest = 0;
    for (const child of handledBy.get(id) ?? []) {
      if (seen.has(child)) continue;
      deepest = Math.max(deepest, 1 + walk(child, new Set([...seen, child])));
    }
    return deepest;
  };
  return walk(threadId, new Set([threadId]));
}

/** Whether `candidateId` is a chat `threadId` started (any depth down). */
export function isSubordinateOf(
  threads: ReadonlyArray<HandlerThreadView>,
  candidateId: string,
  threadId: string,
): boolean {
  const byId = byIdOf(threads);
  const seen = new Set<string>();
  let current = byId.get(candidateId)?.spawnedByThreadId ?? null;
  while (current !== null && !seen.has(current)) {
    if (current === threadId) return true;
    seen.add(current);
    current = byId.get(current)?.spawnedByThreadId ?? null;
  }
  return false;
}

/** Whether `candidateId` is (through its handlers) handled by `threadId`. */
export function isHandledThrough(
  threads: ReadonlyArray<HandlerThreadView>,
  candidateId: string,
  threadId: string,
): boolean {
  const byId = byIdOf(threads);
  const seen = new Set<string>();
  let current: string | null = candidateId;
  while (current !== null && !seen.has(current)) {
    if (current === threadId) return true;
    seen.add(current);
    current = byId.get(current)?.handler?.threadId ?? null;
  }
  return false;
}

/** Why `handlerThreadId` may not handle `threadId`, or null: it may. */
export function handlerRefusal(input: {
  readonly threads: ReadonlyArray<HandlerThreadView>;
  readonly threadId: string;
  readonly handlerThreadId: string;
}): HandlerRefusal | null {
  const { threads, threadId, handlerThreadId } = input;
  if (handlerThreadId === threadId) {
    return { code: "handler_self", detail: "A chat can't handle itself." };
  }
  const handler = threads.find((thread) => thread.id === handlerThreadId);
  if (handler === undefined) {
    return {
      code: "handler_missing",
      detail: `There is no chat '${handlerThreadId}' on this computer.`,
    };
  }
  if ((handler.archivedAt ?? null) !== null || (handler.deletedAt ?? null) !== null) {
    return { code: "handler_archived", detail: "That chat is archived or deleted." };
  }
  if ((handler.handler?.computer ?? null) !== null) {
    return {
      code: "handler_remote",
      detail: "That chat is handed to another computer, so it can't take chats itself.",
    };
  }
  if (isSubordinateOf(threads, handlerThreadId, threadId)) {
    return {
      code: "handler_subordinate",
      detail: "That chat was started by this one: it can't handle the chat it works for.",
    };
  }
  if (isHandledThrough(threads, handlerThreadId, threadId)) {
    return {
      code: "handler_loop",
      detail: "That chat is handled by this one: handing it back would make a loop.",
    };
  }
  const hops = handlerHopsBelow(threads, threadId) + 1 + handlerHopsAbove(threads, handlerThreadId);
  if (hops > THREAD_HANDLER_MAX_DEPTH) {
    return {
      code: "handler_too_deep",
      detail: `Chats can be handed at most ${THREAD_HANDLER_MAX_DEPTH} levels deep.`,
    };
  }
  return null;
}

/**
 * Why `threadId` may not be handed to a chat on ANOTHER computer (T63-C), or
 * null: it may. The handler's computer checks its side (a handler handed on
 * itself, the depth there).
 */
export function remoteHandlerRefusal(input: {
  readonly threads: ReadonlyArray<HandlerThreadView>;
  readonly threadId: string;
}): HandlerRefusal | null {
  if (chatsHandledBy(input.threads, input.threadId).length > 0) {
    return {
      code: "handler_remote_busy",
      detail:
        "This chat handles other chats itself, so it stays on this computer: hand it to a chat here.",
    };
  }
  return null;
}

const clip = (text: string | null | undefined, max: number): string | null => {
  const trimmed = text?.trim() ?? "";
  if (trimmed.length === 0) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
};

export const clipHandlerNote = (note: string | null | undefined) =>
  clip(note, HANDLER_NOTE_MAX_CHARS);
export const clipHandlerTitle = (title: string | null | undefined) =>
  clip(title, HANDLER_TITLE_MAX_CHARS);

/** The chats `handlerThreadId` handles (to give back when it is deleted or archived). */
export function chatsHandledBy(
  threads: ReadonlyArray<HandlerThreadView>,
  handlerThreadId: string,
): ReadonlyArray<string> {
  return threads
    .filter(
      (thread) =>
        thread.handler?.threadId === handlerThreadId && (thread.deletedAt ?? null) === null,
    )
    .map((thread) => thread.id);
}

/**
 * The Needs-you line when a handler is deleted or archived and the chat
 * comes back to the person (T63): "“Launch week” was removed — the chat is
 * yours again". Within PERSON_CALL_REASON_MAX_CHARS.
 */
export function handlerGoneReason(handlerTitle: string | null | undefined): string {
  const tail = " was removed — the chat is yours again";
  const title = clip(handlerTitle, 120);
  return title === null ? `The chat handling it${tail}` : `“${title}”${tail}`;
}

/** The `thread.person-called` payload for a chat whose handler is gone (T63). */
export function handlerGoneCall(
  threadId: ThreadId,
  handlerTitle: string | null | undefined,
  at: string,
) {
  return {
    threadId,
    calledAt: at,
    calledByThreadId: null,
    reason: handlerGoneReason(handlerTitle),
    updatedAt: at,
  };
}

/** How long a handed chat's Ready may wait for its handler before the person sees it (T63). */
export const HANDED_READY_UNCLAIMED_MS = 2 * 60 * 60_000;

/** The Needs-you line when the handler hasn't picked a Ready up in time (T63). */
export function handedReadyUnclaimedReason(handlerTitle: string | null | undefined): string {
  const tail = " hasn't picked this up for 2 h — have a look";
  const title = clip(handlerTitle, 120);
  return title === null ? `Its handler${tail}` : `“${title}”${tail}`;
}
