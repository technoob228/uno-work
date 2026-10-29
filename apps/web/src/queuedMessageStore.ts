/**
 * "Up next": what the person writes while the agent is still working (T3 Code
 * port S4, upstream cc839c42b1 #11673 `queuedMessageStore`, simplified).
 *
 * Enter during a running turn no longer cuts into it: the message waits in
 * the chat's queue, shown at the end of the feed, and goes by itself once the
 * agent has finished (one per finished turn, oldest first). Each waiting
 * message can be edited (back into the composer), deleted, or sent now — the
 * old behaviour: into the running turn.
 *
 * Text only: a message with pictures, files or a recording still goes at
 * once. In memory only — a queued message is a live intent, not a draft.
 */
import { create } from "zustand";

import { randomUUID } from "./lib/utils";

export interface QueuedChatMessage {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
  /**
   * Waits for "Send now" instead of leaving by itself: the person stopped the
   * agent (they want control), or sending it failed.
   */
  readonly hold?: boolean;
}

interface QueuedMessageStoreState {
  readonly queuesByThreadKey: Readonly<Record<string, ReadonlyArray<QueuedChatMessage>>>;
  enqueue: (threadKey: string, text: string) => QueuedChatMessage;
  /** Removes one message and returns it; null when someone already took it. */
  take: (threadKey: string, id: string) => QueuedChatMessage | null;
  /** Puts a message back at the head, held (its send failed). */
  holdAtFront: (threadKey: string, message: QueuedChatMessage) => void;
  /** Every waiting message of the chat waits for "Send now" (the person pressed Stop). */
  holdAll: (threadKey: string) => void;
}

const EMPTY_QUEUE: ReadonlyArray<QueuedChatMessage> = [];

function withQueue(
  queues: Readonly<Record<string, ReadonlyArray<QueuedChatMessage>>>,
  threadKey: string,
  queue: ReadonlyArray<QueuedChatMessage>,
) {
  const next = { ...queues };
  if (queue.length === 0) delete next[threadKey];
  else next[threadKey] = queue;
  return next;
}

export const useQueuedMessageStore = create<QueuedMessageStoreState>()((set, get) => ({
  queuesByThreadKey: {},
  enqueue: (threadKey, text) => {
    const entry: QueuedChatMessage = {
      id: randomUUID(),
      text,
      createdAt: new Date().toISOString(),
    };
    set((state) => ({
      queuesByThreadKey: withQueue(state.queuesByThreadKey, threadKey, [
        ...(state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE),
        entry,
      ]),
    }));
    return entry;
  },
  take: (threadKey, id) => {
    const entry = get().queuesByThreadKey[threadKey]?.find((message) => message.id === id);
    if (!entry) return null;
    set((state) => ({
      queuesByThreadKey: withQueue(
        state.queuesByThreadKey,
        threadKey,
        (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter((message) => message.id !== id),
      ),
    }));
    return entry;
  },
  holdAtFront: (threadKey, message) => {
    set((state) => ({
      queuesByThreadKey: withQueue(state.queuesByThreadKey, threadKey, [
        { ...message, hold: true },
        ...(state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
          (entry) => entry.id !== message.id,
        ),
      ]),
    }));
  },
  holdAll: (threadKey) => {
    const queue = get().queuesByThreadKey[threadKey];
    if (!queue || queue.every((message) => message.hold)) return;
    set((state) => ({
      queuesByThreadKey: withQueue(
        state.queuesByThreadKey,
        threadKey,
        queue.map((message) => (message.hold ? message : { ...message, hold: true })),
      ),
    }));
  },
}));

export function useQueuedMessages(threadKey: string | null): ReadonlyArray<QueuedChatMessage> {
  return useQueuedMessageStore((state) =>
    threadKey ? (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE) : EMPTY_QUEUE,
  );
}

/**
 * Enter while the agent works: queue it (the default), unless it carries
 * something the queue doesn't keep (pictures, files, a recording, terminal
 * context) — that goes at once, as before.
 */
export function shouldQueueSend(input: {
  readonly agentWorking: boolean;
  readonly hasAttachments: boolean;
  readonly sendNow: boolean;
}): boolean {
  return input.agentWorking && !input.hasAttachments && !input.sendNow;
}

/**
 * The first waiting message goes by itself once the chat is free: the agent
 * finished, nothing is being sent, nothing asks the person, no error is on
 * screen (after a failed turn the person decides), and it isn't held.
 */
export function nextQueuedMessageToSend(input: {
  readonly queue: ReadonlyArray<QueuedChatMessage>;
  readonly phase: "disconnected" | "connecting" | "ready" | "running";
  readonly busy: boolean;
  readonly waitingForPerson: boolean;
  readonly hasError: boolean;
}): QueuedChatMessage | null {
  const first = input.queue[0];
  if (!first || first.hold) return null;
  if (input.phase !== "ready") return null;
  if (input.busy || input.waitingForPerson || input.hasError) return null;
  return first;
}
