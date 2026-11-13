import { beforeEach, describe, expect, it } from "vitest";

import {
  claimQueuedMessages,
  isQueueOwnedOnScreen,
  joinQueuedAhead,
  nextQueuedMessageToSend,
  queuedTurnIds,
  queuePause,
  planQueuedSend,
  queuedAheadOfSend,
  QUEUED_MESSAGE_HOLD_AFTER_MS,
  QUEUED_MESSAGES_STORAGE_KEY,
  restoreQueues,
  shouldQueueSend,
  useQueuedMessageStore,
} from "./queuedMessageStore";

const KEY = "env:thread-1";
const store = () => useQueuedMessageStore.getState();
const queue = () => store().queuesByThreadKey[KEY] ?? [];

beforeEach(() => {
  useQueuedMessageStore.setState({ queuesByThreadKey: {} });
});

describe("a reload", () => {
  const storage = () => useQueuedMessageStore.persist.getOptions().storage!;

  it("finds the queue where it was left, in order", async () => {
    store().enqueue(KEY, "one");
    store().enqueue(KEY, "two");
    const beforeReload = store().queuesByThreadKey;
    useQueuedMessageStore.setState({ queuesByThreadKey: {} });
    await storage().setItem(QUEUED_MESSAGES_STORAGE_KEY, {
      state: { queuesByThreadKey: beforeReload },
      version: 1,
    });
    await useQueuedMessageStore.persist.rehydrate();
    expect(queue().map((message) => message.text)).toEqual(["one", "two"]);
  });

  it("holds what waited too long: the person left, the chat moved on", () => {
    const now = Date.parse("2026-10-30T12:00:00.000Z");
    const fresh = new Date(now - 60_000).toISOString();
    const old = new Date(now - QUEUED_MESSAGE_HOLD_AFTER_MS - 1).toISOString();
    const restored = restoreQueues(
      {
        queuesByThreadKey: {
          [KEY]: [
            { id: "1", text: "fresh", createdAt: fresh },
            { id: "2", text: "old", createdAt: old },
          ],
        },
      },
      now,
    );
    expect(restored[KEY]?.map((message) => [message.text, message.hold ?? false])).toEqual([
      ["fresh", false],
      ["old", true],
    ]);
  });

  it("survives garbage in the storage", () => {
    expect(restoreQueues(null, 0)).toEqual({});
    expect(restoreQueues({ queuesByThreadKey: "x" }, 0)).toEqual({});
    expect(restoreQueues({ queuesByThreadKey: { [KEY]: [{ id: 1 }] } }, 0)).toEqual({});
  });

  it("forgets the queue of a deleted chat", () => {
    store().enqueue(KEY, "one");
    store().clearThread(KEY);
    expect(KEY in store().queuesByThreadKey).toBe(false);
  });
});

describe("two tabs", () => {
  it("lets one message leave once: a tab sees the other took it", async () => {
    const entry = store().enqueue(KEY, "one");
    const storage = useQueuedMessageStore.persist.getOptions().storage!;
    // The other tab took it first: the storage no longer has it, this tab's copy still does.
    await storage.setItem(QUEUED_MESSAGES_STORAGE_KEY, {
      state: { queuesByThreadKey: {} },
      version: 1,
    });
    expect(store().take(KEY, entry.id)).toBeNull();
    expect(queue()).toEqual([]);
  });
});

describe("queuedMessageStore", () => {
  it("keeps messages in order and takes each one once", () => {
    const first = store().enqueue(KEY, "one");
    store().enqueue(KEY, "two");
    expect(queue().map((message) => message.text)).toEqual(["one", "two"]);
    expect(store().take(KEY, first.id)?.text).toBe("one");
    expect(store().take(KEY, first.id)).toBeNull();
    expect(queue().map((message) => message.text)).toEqual(["two"]);
  });

  it("drops the chat's key when its queue empties", () => {
    const only = store().enqueue(KEY, "one");
    store().take(KEY, only.id);
    expect(KEY in store().queuesByThreadKey).toBe(false);
  });

  it("puts a failed send back first, held", () => {
    const first = store().enqueue(KEY, "one");
    store().enqueue(KEY, "two");
    const taken = store().take(KEY, first.id)!;
    store().holdAtFront(KEY, taken);
    expect(queue().map((message) => [message.text, message.hold ?? false])).toEqual([
      ["one", true],
      ["two", false],
    ]);
  });

  it("holds everything after Stop", () => {
    store().enqueue(KEY, "one");
    store().enqueue(KEY, "two");
    store().holdAll(KEY);
    expect(queue().every((message) => message.hold)).toBe(true);
  });
});

describe("shouldQueueSend", () => {
  it("queues plain text while the agent works, by default", () => {
    expect(shouldQueueSend({ agentWorking: true, hasAttachments: false, sendNow: false })).toBe(
      true,
    );
    expect(shouldQueueSend({ agentWorking: false, hasAttachments: false, sendNow: false })).toBe(
      false,
    );
    expect(shouldQueueSend({ agentWorking: true, hasAttachments: true, sendNow: false })).toBe(
      false,
    );
    expect(shouldQueueSend({ agentWorking: true, hasAttachments: false, sendNow: true })).toBe(
      false,
    );
  });

  it("leaves an offline message to the outbox, never both", () => {
    expect(
      shouldQueueSend({
        agentWorking: true,
        hasAttachments: false,
        sendNow: false,
        linkDown: true,
      }),
    ).toBe(false);
  });
});

// qa 11.11: after a failed turn "Up next" paused; the next Enter went at once
// and the older waiting message only after it and its reply.
describe("planQueuedSend: nothing typed now overtakes Up next", () => {
  const typed = { agentWorking: false, hasAttachments: false, sendNow: false };

  it("goes as before when nothing waits", () => {
    expect(planQueuedSend({ ...typed, queue: [] })).toEqual({ kind: "send" });
    expect(planQueuedSend({ ...typed, queue: [], agentWorking: true })).toEqual({
      kind: "queue",
      releaseFirst: false,
    });
    expect(planQueuedSend({ ...typed, queue: [], hasAttachments: true })).toEqual({
      kind: "send",
    });
  });

  it("after a failed turn: the new message joins the back, the oldest waiting one goes now", () => {
    store().enqueue(KEY, "older");
    // The chat is free (the error paused the queue): the old code sent the new one at once.
    expect(planQueuedSend({ ...typed, queue: queue() })).toEqual({
      kind: "queue",
      releaseFirst: true,
    });
  });

  it("offline: the new message waits behind them, nothing goes", () => {
    store().enqueue(KEY, "older");
    expect(planQueuedSend({ ...typed, queue: queue(), linkDown: true })).toEqual({
      kind: "queue",
      releaseFirst: false,
    });
    expect(
      planQueuedSend({ ...typed, queue: queue(), agentWorking: true, linkDown: true }),
    ).toEqual({ kind: "queue", releaseFirst: false });
  });

  it("a message with a picture takes the waiting ones with it, first, in order", () => {
    const first = store().enqueue(KEY, "one");
    const second = store().enqueue(KEY, "two");
    for (const agentWorking of [true, false]) {
      const plan = planQueuedSend({ ...typed, queue: queue(), agentWorking, hasAttachments: true });
      expect(plan.kind).toBe("send-with-ahead");
      if (plan.kind !== "send-with-ahead") return;
      expect(plan.ahead.map((message) => message.id)).toEqual([first.id, second.id]);
    }
    // Leaving the chat (Up next stays still there) does the same.
    expect(
      planQueuedSend({ ...typed, queue: queue(), agentWorking: true, sendNow: true }).kind,
    ).toBe("send-with-ahead");
    expect(joinQueuedAhead(["one", "two"], "look at this")).toBe("one\n\ntwo\n\nlook at this");
    expect(joinQueuedAhead(["one"], "")).toBe("one");
  });

  it("a held queue waits for the person: the new message isn't overtaking it", () => {
    store().enqueue(KEY, "one");
    store().holdAll(KEY);
    expect(planQueuedSend({ ...typed, queue: queue() })).toEqual({ kind: "send" });
    expect(planQueuedSend({ ...typed, queue: queue(), hasAttachments: true })).toEqual({
      kind: "send",
    });
  });

  it("only what goes by itself is ahead: up to the first held one", () => {
    const at = new Date().toISOString();
    const ahead = queuedAheadOfSend([
      { id: "1", text: "one", createdAt: at },
      { id: "2", text: "two", createdAt: at, hold: true },
      { id: "3", text: "three", createdAt: at },
    ]);
    expect(ahead.map((message) => message.text)).toEqual(["one"]);
  });
});

describe("nextQueuedMessageToSend", () => {
  const base = { phase: "ready" as const, busy: false, waitingForPerson: false, hasError: false };

  it("sends the first message once the chat is free", () => {
    const first = store().enqueue(KEY, "one");
    store().enqueue(KEY, "two");
    expect(nextQueuedMessageToSend({ ...base, queue: queue() })?.id).toBe(first.id);
  });

  it("waits while the agent works, a send is on its way, the person is asked, or after an error", () => {
    store().enqueue(KEY, "one");
    expect(nextQueuedMessageToSend({ ...base, queue: queue(), phase: "running" })).toBeNull();
    expect(nextQueuedMessageToSend({ ...base, queue: queue(), phase: "connecting" })).toBeNull();
    expect(nextQueuedMessageToSend({ ...base, queue: queue(), busy: true })).toBeNull();
    expect(nextQueuedMessageToSend({ ...base, queue: queue(), waitingForPerson: true })).toBeNull();
    expect(nextQueuedMessageToSend({ ...base, queue: queue(), hasError: true })).toBeNull();
  });

  it("does not send a held message, nor overtake it", () => {
    store().enqueue(KEY, "one");
    store().enqueue(KEY, "two");
    store().holdAll(KEY);
    expect(nextQueuedMessageToSend({ ...base, queue: queue() })).toBeNull();
  });
});

describe("T48: Up next goes once the agent is done, however the turn ended", () => {
  const base = { phase: "ready" as const, busy: false, waitingForPerson: false, hasError: false };

  it("goes into a chat whose session the computer let go (idle 15 min, a restart)", () => {
    const first = store().enqueue(KEY, "one");
    expect(nextQueuedMessageToSend({ ...base, queue: queue(), phase: "disconnected" })?.id).toBe(
      first.id,
    );
  });

  it("a long turn or an app update doesn't hold it at a reload: only a day-old tab does", () => {
    const now = Date.parse("2026-11-13T12:00:00.000Z");
    const message = (minutesAgo: number) => ({
      id: `m-${minutesAgo}`,
      text: "go on",
      createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
    });
    const restored = restoreQueues(
      { queuesByThreadKey: { [KEY]: [message(45), message(13 * 60)] } },
      now,
    )[KEY]!;
    expect(restored.map((entry) => entry.hold ?? false)).toEqual([false, true]);
  });

  it("says what it waits for: the person, or a failed turn — never 'when the agent is done'", () => {
    expect(queuePause({ phase: "ready", waitingForPerson: true, hasError: false })).toBe("person");
    expect(queuePause({ phase: "ready", waitingForPerson: false, hasError: true })).toBe("error");
    expect(queuePause({ phase: "disconnected", waitingForPerson: false, hasError: false })).toBe(
      null,
    );
    expect(queuePause({ phase: "running", waitingForPerson: true, hasError: true })).toBe(null);
  });

  it("the same message is the same command wherever it is tried", () => {
    const message = store().enqueue(KEY, "one");
    expect(queuedTurnIds(message)).toEqual(queuedTurnIds({ id: message.id }));
    expect(queuedTurnIds(message).commandId).not.toBe(
      queuedTurnIds(store().enqueue(KEY, "two")).commandId,
    );
  });

  it("refused by the computer: back first, held, as a new try", () => {
    const message = store().enqueue(KEY, "one");
    store().enqueue(KEY, "two");
    const taken = store().take(KEY, message.id)!;
    store().holdAtFront(KEY, taken, { retry: true });
    expect(queue().map((entry) => entry.text)).toEqual(["one", "two"]);
    expect(queue()[0]!.hold).toBe(true);
    expect(queue()[0]!.id).not.toBe(message.id);
  });

  it("never sent (no link at that moment): back first, as it was", () => {
    const message = store().enqueue(KEY, "one");
    store().enqueue(KEY, "two");
    store().putBackFirst(KEY, store().take(KEY, message.id)!);
    expect(queue()[0]).toEqual(message);
  });

  it("an open chat claims its queue until it closes, counted", () => {
    const releaseMain = claimQueuedMessages(KEY);
    const releasePanel = claimQueuedMessages(KEY);
    releaseMain();
    releaseMain();
    expect(isQueueOwnedOnScreen(KEY)).toBe(true);
    releasePanel();
    expect(isQueueOwnedOnScreen(KEY)).toBe(false);
  });
});
