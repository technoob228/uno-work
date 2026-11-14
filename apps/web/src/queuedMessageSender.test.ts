import {
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type EnvironmentId,
  type OrchestrationLatestTurn,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime";
import { beforeEach, describe, expect, it } from "vitest";

import { useOutboxStore, type OutboxTurnStartCommand } from "./outbox/outboxStore";
import { useQueuedMessageStore } from "./queuedMessageStore";
import {
  QUEUED_SEND_ACK_TIMEOUT_MS,
  resetQueuedMessageSenderForTests,
  sendDueQueuedMessagesOnce,
  type QueuedChatState,
  type QueuedSenderDeps,
} from "./queuedMessageSender";
import { TransportConnectionLostError } from "./rpc/transportError";
import type { ThreadSession } from "./types";

const ENV = "env-a" as EnvironmentId;
const THREAD = ThreadId.make("thread-1");
const KEY = scopedThreadKey(scopeThreadRef(ENV, THREAD));
const T0 = Date.parse("2026-11-13T12:00:00.000Z");
const RESTART_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";

function session(
  status: ThreadSession["status"],
  orchestrationStatus: ThreadSession["orchestrationStatus"],
  updatedAt = "2026-11-13T11:00:00.000Z",
): ThreadSession {
  return {
    provider: "claudeAgent" as ThreadSession["provider"],
    status,
    orchestrationStatus,
    createdAt: "2026-11-13T10:00:00.000Z",
    updatedAt,
  };
}

function turn(id: string, state: OrchestrationLatestTurn["state"]): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make(id),
    state,
    requestedAt: "2026-11-13T10:00:00.000Z",
    startedAt: "2026-11-13T10:00:01.000Z",
    completedAt: state === "running" ? null : "2026-11-13T11:00:00.000Z",
    assistantMessageId: null,
  };
}

const DONE: Partial<QueuedChatState> = {
  session: session("ready", "ready"),
  latestTurn: turn("turn-1", "completed"),
};

let chat: QueuedChatState;
let now: number;
let linkUp: boolean;
let owned: boolean;
let dispatched: OutboxTurnStartCommand[];
let dispatchResult: () => Promise<unknown> | undefined;
let refused: unknown[];

const deps: QueuedSenderDeps = {
  now: () => now,
  readChat: () => chat,
  isLinkUp: () => linkUp,
  ownedOnScreen: () => owned,
  dispatch: (_environmentId, command) => {
    dispatched.push(command);
    return dispatchResult();
  },
  onRefused: (_chat, error) => refused.push(error),
};

const queue = () => useQueuedMessageStore.getState().queuesByThreadKey[KEY] ?? [];
const enqueue = (text: string) => useQueuedMessageStore.getState().enqueue(KEY, text);
const setChat = (patch: Partial<QueuedChatState>) => {
  chat = { ...chat, ...patch };
};
const pass = () => sendDueQueuedMessagesOnce(deps);

beforeEach(() => {
  resetQueuedMessageSenderForTests();
  useQueuedMessageStore.setState({ queuesByThreadKey: {} });
  useOutboxStore.setState({ entries: [] });
  now = T0;
  linkUp = true;
  owned = false;
  dispatched = [];
  refused = [];
  dispatchResult = () => Promise.resolve({ sequence: 1 });
  chat = {
    title: "Landing page",
    session: session("running", "running"),
    latestTurn: turn("turn-1", "running"),
    waitingForPerson: false,
    error: null,
    archived: false,
    modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
  };
});

describe("Up next of a chat that isn't on screen (T48)", () => {
  it("waits while the agent works, goes once it is done — with the chat's own settings", async () => {
    const message = enqueue("and add a footer");
    await pass();
    expect(dispatched).toHaveLength(0);

    setChat(DONE);
    await pass();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.turn.start",
      threadId: THREAD,
      commandId: `queued-turn:${message.id}`,
      message: { messageId: `queued:${message.id}`, text: "and add a footer", attachments: [] },
      modelSelection: chat.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    expect(queue()).toHaveLength(0);
  });

  it("goes into a chat whose session the computer let go after the turn (15 min idle)", async () => {
    enqueue("go on");
    setChat({ session: session("closed", "stopped"), latestTurn: turn("turn-1", "completed") });
    await pass();
    expect(dispatched).toHaveLength(1);
  });

  it("one per finished turn: the next waits until the computer has shown the turn", async () => {
    enqueue("one");
    enqueue("two");
    setChat(DONE);
    await pass();
    expect(dispatched.map((command) => command.message.text)).toEqual(["one"]);

    // The chat looks free a moment longer — the turn hasn't shown up yet.
    await pass();
    expect(dispatched).toHaveLength(1);

    // The turn starts (another agent's message may start one too: same thing)...
    setChat({ session: session("running", "running", "2026-11-13T12:00:01.000Z") });
    setChat({ latestTurn: turn("turn-2", "running") });
    await pass();
    expect(dispatched).toHaveLength(1);

    // ...and ends: the second goes.
    setChat({
      session: session("ready", "ready", "2026-11-13T12:05:00.000Z"),
      latestTurn: turn("turn-2", "completed"),
    });
    await pass();
    expect(dispatched.map((command) => command.message.text)).toEqual(["one", "two"]);
  });

  it("a turn that never shows up doesn't hold the queue for good", async () => {
    enqueue("one");
    enqueue("two");
    setChat(DONE);
    await pass();
    now = T0 + QUEUED_SEND_ACK_TIMEOUT_MS;
    await pass();
    expect(dispatched).toHaveLength(2);
  });

  it("leaves the chat to its open view, which sends with the composer's settings", async () => {
    enqueue("one");
    setChat(DONE);
    owned = true;
    await pass();
    expect(dispatched).toHaveLength(0);
    expect(queue()).toHaveLength(1);
  });

  it("waits for the person: a question or an approval, a failed turn, Stop", async () => {
    enqueue("one");
    setChat({ ...DONE, waitingForPerson: true });
    await pass();
    setChat({ waitingForPerson: false, error: "Claude Code returned an error result" });
    await pass();
    setChat({ error: null });
    useQueuedMessageStore.getState().holdAll(KEY);
    await pass();
    expect(dispatched).toHaveLength(0);
  });

  it("a restart cut the turn off: waits for the daemon to continue it, then goes on", async () => {
    enqueue("one");
    setChat({
      session: session("error", "error", new Date(T0 - 5_000).toISOString()),
      latestTurn: turn("turn-1", "interrupted"),
      error: RESTART_ERROR,
    });
    await pass();
    expect(dispatched).toHaveLength(0);
    now = T0 + 20_000;
    await pass();
    expect(dispatched).toHaveLength(1);
  });

  it("offline or archived: nothing goes, nothing is lost", async () => {
    enqueue("one");
    setChat(DONE);
    linkUp = false;
    await pass();
    linkUp = true;
    setChat({ archived: true });
    await pass();
    expect(dispatched).toHaveLength(0);
    expect(queue()).toHaveLength(1);
  });

  it("two passes at once (two windows' kicks) send it once", async () => {
    enqueue("one");
    setChat(DONE);
    await Promise.all([pass(), pass()]);
    expect(dispatched).toHaveLength(1);
  });

  it("refused by the computer: back first, held for Send now, the person is told", async () => {
    enqueue("one");
    setChat(DONE);
    dispatchResult = () => Promise.reject(new Error("Thread is archived."));
    await pass();
    expect(queue()).toHaveLength(1);
    expect(queue()[0]).toMatchObject({ text: "one", hold: true });
    expect(refused).toHaveLength(1);
  });

  it("the link drops under it: the outbox delivers the same command, once", async () => {
    const message = enqueue("one");
    setChat(DONE);
    dispatchResult = () => Promise.reject(new TransportConnectionLostError());
    await pass();
    expect(queue()).toHaveLength(0);
    const entries = useOutboxStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.command.commandId).toBe(`queued-turn:${message.id}`);
  });

  it("no API for the computer at that moment: back first, as it was", async () => {
    const message = enqueue("one");
    setChat(DONE);
    dispatchResult = () => undefined;
    await pass();
    expect(queue()).toEqual([message]);
  });
});
