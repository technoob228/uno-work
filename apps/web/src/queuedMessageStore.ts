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
 * once — with what waits here going first in it, so nothing typed later
 * overtakes the queue (planQueuedSend). Kept in localStorage: a reload must not lose what the person wrote
 * (qa 30.10: it vanished without a word). What waited very long (a tab from
 * yesterday) stops going by itself: "Send now" is theirs to press.
 * Several tabs share the queue, and a message leaves from one of them only.
 *
 * Who sends it (T48, 13.11): the open chat (ChatView, with the composer's
 * model and effort) or, when the chat isn't on screen, the app-wide sender
 * (queuedMessageSender.ts) with the chat's own settings. A chat the computer
 * put to sleep after the turn (the session reaper, 15 min idle; a restart) is
 * free too: the message wakes it, as a typed one does. Either way the turn
 * goes with ids made from the queued message's id, so a second try anywhere
 * (another tab, a retry) is the same command and the computer takes it once.
 */
import { CommandId, MessageId } from "@t3tools/contracts";
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
  /**
   * Puts a message back at the head, held (its send failed). `retry: true`:
   * the computer refused that try, so the next one (Send now) is a new
   * command — the same ids would only get the old refusal back.
   */
  holdAtFront: (
    threadKey: string,
    message: QueuedChatMessage,
    options?: { readonly retry?: boolean },
  ) => void;
  /** Puts a message that never went back at the head, as it was. */
  putBackFirst: (threadKey: string, message: QueuedChatMessage) => void;
  /** Every waiting message of the chat waits for "Send now" (the person pressed Stop). */
  holdAll: (threadKey: string) => void;
  /** The chat is gone: nothing of it waits. */
  clearThread: (threadKey: string) => void;
}

const EMPTY_QUEUE: ReadonlyArray<QueuedChatMessage> = [];

export const QUEUED_MESSAGES_STORAGE_KEY = "uno.queued-messages.v1";

/** After a restart cut a turn off, how long the daemon gets to continue it itself. */
export const QUEUE_AFTER_RESTART_DELAY_MS = 20_000;

/**
 * Older than this at a reload: waits for "Send now". Not shorter: a long turn,
 * or the app restarting for an update while the person is away, must not
 * stop the queue (T48: 30 min held what Misha expected to go).
 */
export const QUEUED_MESSAGE_HOLD_AFTER_MS = 12 * 60 * 60_000;

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
      holdAtFront: (threadKey, message, options) => {
        set((state) => ({
          queuesByThreadKey: withQueue(state.queuesByThreadKey, threadKey, [
            { ...message, ...(options?.retry ? { id: randomUUID() } : {}), hold: true },
            ...(state.queuesByThreadKey[threadKey] ?? EMPTY_QUEUE).filter(
              (entry) => entry.id !== message.id,
            ),
          ]),
        }));
      },
      putBackFirst: (threadKey, message) => {
        set((state) => ({
          queuesByThreadKey: withQueue(state.queuesByThreadKey, threadKey, [
            message,
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
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
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
 * What "Up next" sends by itself before anything typed now: the messages up
 * to the first held one. Empty when the first is held — then the queue waits
 * for the person (Send now), and a new message isn't overtaking it.
 */
export function queuedAheadOfSend(
  queue: ReadonlyArray<QueuedChatMessage>,
): ReadonlyArray<QueuedChatMessage> {
  const firstHeld = queue.findIndex((message) => message.hold);
  return firstHeld === -1 ? queue : queue.slice(0, firstHeld);
}

/**
 * How a message typed now goes, so it never overtakes what waits in "Up next"
 * (qa 11.11: after a failed turn the queue paused, the next Enter went at
 * once and the older waiting message only after it and its reply):
 * - "send": nothing waits ahead — it goes as before (or "Up next" while the
 *   agent works, shouldQueueSend);
 * - "queue": it joins the back of "Up next"; `releaseFirst` — the chat is free
 *   (or paused after an error: this Enter is the person going on), so the
 *   oldest waiting message goes now, the rest one per finished turn;
 * - "send-with-ahead": it can't wait in "Up next" (pictures, files, a
 *   recording, terminal context, a send on the way out of the chat), so the
 *   waiting messages go in it, first, in order (joinQueuedAhead).
 */
export type QueuedSendPlan =
  | { readonly kind: "send" }
  | { readonly kind: "queue"; readonly releaseFirst: boolean }
  | { readonly kind: "send-with-ahead"; readonly ahead: ReadonlyArray<QueuedChatMessage> };

export function planQueuedSend(input: {
  readonly queue: ReadonlyArray<QueuedChatMessage>;
  readonly agentWorking: boolean;
  readonly hasAttachments: boolean;
  readonly sendNow: boolean;
  readonly linkDown?: boolean;
}): QueuedSendPlan {
  if (shouldQueueSend(input)) return { kind: "queue", releaseFirst: false };
  const ahead = queuedAheadOfSend(input.queue);
  if (ahead.length === 0) return { kind: "send" };
  if (!input.hasAttachments && !input.sendNow) {
    return {
      kind: "queue",
      releaseFirst: !input.agentWorking && !(input.linkDown ?? false),
    };
  }
  return { kind: "send-with-ahead", ahead };
}

/** The waiting messages' text first, then what was typed: one message, in order. */
export function joinQueuedAhead(ahead: ReadonlyArray<string>, text: string): string {
  return [...ahead, text].filter((part) => part.trim().length > 0).join("\n\n");
}

type QueuePhase = "disconnected" | "connecting" | "ready" | "running";

/**
 * The first waiting message goes by itself once the chat is free: the agent
 * finished, nothing is being sent, nothing asks the person, no error is on
 * screen (after a failed turn the person decides), and it isn't held.
 *
 * "disconnected" is free: the turn is over and the computer let the agent's
 * session go (idle 15 min, a restart) — the message starts it again, like a
 * typed one. Before T48 only "ready" counted, so anything still waiting 15
 * minutes after the turn waited for good, under "Sends when the agent is done".
 */
export function nextQueuedMessageToSend(input: {
  readonly queue: ReadonlyArray<QueuedChatMessage>;
  readonly phase: QueuePhase;
  readonly busy: boolean;
  readonly waitingForPerson: boolean;
  readonly hasError: boolean;
}): QueuedChatMessage | null {
  const first = input.queue[0];
  if (!first || first.hold) return null;
  if (input.phase === "running" || input.phase === "connecting") return null;
  if (input.busy || input.waitingForPerson || input.hasError) return null;
  return first;
}

/**
 * Why the first waiting message isn't going though the agent is done — for
 * its line in "Up next", so it never says "Sends when the agent is done" over
 * a queue that waits for the person.
 */
export type QueuePause = "error" | "person" | null;

export function queuePause(input: {
  readonly phase: QueuePhase;
  readonly waitingForPerson: boolean;
  readonly hasError: boolean;
}): QueuePause {
  if (input.phase === "running" || input.phase === "connecting") return null;
  if (input.waitingForPerson) return "person";
  if (input.hasError) return "error";
  return null;
}

/**
 * The turn a queued message starts: the same ids wherever and however often
 * it is tried, so the computer's command receipts take it once (two tabs, two
 * windows, a retry after a lost answer).
 */
export function queuedTurnIds(message: Pick<QueuedChatMessage, "id">): {
  readonly commandId: CommandId;
  readonly messageId: MessageId;
} {
  return {
    commandId: CommandId.make(`queued-turn:${message.id}`),
    messageId: MessageId.make(`queued:${message.id}`),
  };
}

/**
 * Chats whose queue an open chat view sends (with the composer's settings);
 * the app-wide sender leaves those alone. A count: the same chat can be open
 * twice (the main view and a panel).
 */
const queueOwners = new Map<string, number>();

export function claimQueuedMessages(threadKey: string): () => void {
  queueOwners.set(threadKey, (queueOwners.get(threadKey) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (queueOwners.get(threadKey) ?? 1) - 1;
    if (left <= 0) queueOwners.delete(threadKey);
    else queueOwners.set(threadKey, left);
  };
}

export function isQueueOwnedOnScreen(threadKey: string): boolean {
  return queueOwners.has(threadKey);
}
