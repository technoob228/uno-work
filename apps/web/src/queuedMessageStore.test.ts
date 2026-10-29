import { beforeEach, describe, expect, it } from "vitest";

import {
  nextQueuedMessageToSend,
  shouldQueueSend,
  useQueuedMessageStore,
} from "./queuedMessageStore";

const KEY = "env:thread-1";
const store = () => useQueuedMessageStore.getState();
const queue = () => store().queuesByThreadKey[KEY] ?? [];

beforeEach(() => {
  useQueuedMessageStore.setState({ queuesByThreadKey: {} });
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
