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
 * once. Kept in localStorage: a reload must not lose what the person wrote
 * (qa 30.10: it vanished without a word). What waited long stops going by
 * itself: the person left, the chat moved on, "Send now" is theirs to press.
 * Several tabs share the queue, and a message leaves from one of them only.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";
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
  /** The chat is gone: nothing of it waits. */
  clearThread: (threadKey: string) => void;
}

const EMPTY_QUEUE: ReadonlyArray<QueuedChatMessage> = [];

export const QUEUED_MESSAGES_STORAGE_KEY = "uno.queued-messages.v1";

/** Older than this at a reload: waits for "Send now". */
export const QUEUED_MESSAGE_HOLD_AFTER_MS = 30 * 60_000;

type Queues = Readonly<Record<string, ReadonlyArray<QueuedChatMessage>>>;

const queueStorage = resolveStorage(
  typeof window !== "undefined" ? window.localStorage : undefined,
);

function isQueuedMessage(value: unknown): value is QueuedChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message["id"] === "string" &&
    typeof message["text"] === "string" &&
    typeof message["createdAt"] === "string"
  );
}

/** What a reload finds: valid messages, the long-waiting ones held. */
export function restoreQueues(persisted: unknown, now: number): Queues {
  const raw = (persisted as { queuesByThreadKey?: unknown } | null | undefined)?.queuesByThreadKey;
  if (typeof raw !== "object" || raw === null) return {};
  const queues: Record<string, ReadonlyArray<QueuedChatMessage>> = {};
  for (const [threadKey, queue] of Object.entries(raw)) {
    if (!Array.isArray(queue)) continue;
    const messages = queue.filter(isQueuedMessage).map((message) => {
      const age = now - Date.parse(message.createdAt);
      return age < QUEUED_MESSAGE_HOLD_AFTER_MS ? message : { ...message, hold: true };
    });
    if (messages.length > 0) queues[threadKey] = messages;
  }
  return queues;
}

/** Another tab took it a moment ago: the storage is written before anything else happens. */
function takenElsewhere(threadKey: string, id: string): boolean {
  try {
    const raw = queueStorage.getItem(QUEUED_MESSAGES_STORAGE_KEY);
    if (typeof raw !== "string") return false;
    const stored = (JSON.parse(raw) as { state?: { queuesByThreadKey?: Queues } }).state;
    return !stored?.queuesByThreadKey?.[threadKey]?.some((message) => message.id === id);
  } catch {
    return false;
  }
}

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

export const useQueuedMessageStore = create<QueuedMessageStoreState>()(
  persist(
    (set, get) => ({
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
        const elsewhere = takenElsewhere(threadKey, id);
        set((state) => ({
          queuesByThreadKey: withQueue(
            state.queuesByThreadKey,
            threadKey,
            (state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
              (message) => message.id !== id,
            ),
          ),
        }));
        return elsewhere ? null : entry;
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
      clearThread: (threadKey) => {
        if (!get().queuesByThreadKey[threadKey]) return;
        set((state) => ({
          queuesByThreadKey: withQueue(state.queuesByThreadKey, threadKey, EMPTY_QUEUE),
        }));
      },
    }),
    {
      name: QUEUED_MESSAGES_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => queueStorage),
      partialize: (state) => ({ queuesByThreadKey: state.queuesByThreadKey }),
      merge: (persisted, current) => ({
        ...current,
        queuesByThreadKey: restoreQueues(persisted, Date.now()),
      }),
    },
  ),
);

// What another tab queued or sent shows here too: a stale copy would send it twice.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === QUEUED_MESSAGES_STORAGE_KEY) void useQueuedMessageStore.persist.rehydrate();
  });
}

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
  /** Computer unreachable: the message goes to the outbox, not "Up next". */
  readonly linkDown?: boolean;
}): boolean {
  return input.agentWorking && !input.hasAttachments && !input.sendNow && !input.linkDown;
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
