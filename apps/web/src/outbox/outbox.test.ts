import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { TransportConnectionLostError } from "../rpc/transportError";
import { flushOutboxOnce, resetOutboxFlusherForTests, type OutboxFlushDeps } from "./outboxFlusher";
import {
  OUTBOX_STORAGE_KEY,
  isOutboxEligibleSend,
  nextOutboxDeliveries,
  useOutboxStore,
  type OutboxTurnStartCommand,
} from "./outboxStore";

const ENV_A = "env-a" as EnvironmentId;
const ENV_B = "env-b" as EnvironmentId;
const THREAD_1 = ThreadId.make("thread-1");
const THREAD_2 = ThreadId.make("thread-2");

let counter = 0;
function command(threadId: ThreadId = THREAD_1, text = "hello"): OutboxTurnStartCommand {
  counter += 1;
  return {
    type: "thread.turn.start",
    commandId: CommandId.make(`cmd-${counter}`),
    threadId,
    message: {
      messageId: MessageId.make(`msg-${counter}`),
      role: "user",
      text,
      attachments: [],
    },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-10-29T12:00:00.000Z",
  } as OutboxTurnStartCommand;
}

function enqueue(environmentId: EnvironmentId, cmd: OutboxTurnStartCommand) {
  useOutboxStore.getState().enqueue({ environmentId, command: cmd });
  return cmd;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const statuses = () => useOutboxStore.getState().entries.map((entry) => entry.status);

beforeEach(() => {
  useOutboxStore.setState({ entries: [] });
  resetOutboxFlusherForTests();
});

describe("outbox store", () => {
  it("queues a message once per messageId and persists it", () => {
    const cmd = command();
    enqueue(ENV_A, cmd);
    enqueue(ENV_A, cmd);
    expect(useOutboxStore.getState().entries).toHaveLength(1);
    expect(useOutboxStore.getState().entries[0]).toMatchObject({
      id: cmd.message.messageId,
      status: "waiting",
      attempts: 0,
    });
    const persisted = useOutboxStore.persist.getOptions().storage?.getItem(OUTBOX_STORAGE_KEY);
    expect(persisted).toMatchObject({
      state: { entries: [{ command: { commandId: cmd.commandId } }] },
    });
  });

  it("after a reload an interrupted send is back in line with the same command", async () => {
    const cmd = enqueue(ENV_A, command());
    useOutboxStore.getState().markSending(cmd.message.messageId);
    useOutboxStore.setState({ entries: [] }, false);
    // setState above persisted the empty list; put the "sending" snapshot back.
    useOutboxStore.persist.getOptions().storage?.setItem(OUTBOX_STORAGE_KEY, {
      state: {
        entries: [
          {
            id: cmd.message.messageId,
            environmentId: ENV_A,
            threadId: THREAD_1,
            queuedAt: cmd.createdAt,
            command: cmd,
            status: "sending",
            attempts: 1,
            error: null,
          },
        ],
      },
      version: 1,
    });
    await useOutboxStore.persist.rehydrate();
    expect(useOutboxStore.getState().entries).toMatchObject([
      { status: "waiting", command: { commandId: cmd.commandId } },
    ]);
  });

  it("delivers per chat in order, one at a time, and only for reachable computers", () => {
    const a1 = enqueue(ENV_A, command(THREAD_1));
    enqueue(ENV_A, command(THREAD_1));
    const a2 = enqueue(ENV_A, command(THREAD_2));
    enqueue(ENV_B, command(THREAD_1));
    const ready = nextOutboxDeliveries(useOutboxStore.getState().entries, (env) => env === ENV_A);
    expect(ready.map((entry) => entry.id)).toEqual([a1.message.messageId, a2.message.messageId]);

    // A failed message holds its chat back until Retry or Discard.
    useOutboxStore.getState().markFailed(a1.message.messageId, "rejected");
    const afterFailure = nextOutboxDeliveries(useOutboxStore.getState().entries, () => true);
    expect(afterFailure.map((entry) => entry.threadId)).toEqual([THREAD_2, THREAD_1]);
    expect(afterFailure.map((entry) => entry.environmentId)).toEqual([ENV_A, ENV_B]);
  });

  it("Retry after a rejection sends under a new commandId (the old one has a rejected receipt)", () => {
    const cmd = enqueue(ENV_A, command());
    useOutboxStore.getState().markFailed(cmd.message.messageId, "rejected");
    useOutboxStore.getState().retry(cmd.message.messageId);
    const [entry] = useOutboxStore.getState().entries;
    expect(entry?.status).toBe("waiting");
    expect(entry?.error).toBeNull();
    expect(entry?.command.commandId).not.toBe(cmd.commandId);
    expect(entry?.command.message.messageId).toBe(cmd.message.messageId);
  });

  it("only plain sends to existing chats are queued", () => {
    expect(
      isOutboxEligibleSend({ isServerThread: true, hasAttachments: false, needsBootstrap: false }),
    ).toBe(true);
    expect(
      isOutboxEligibleSend({ isServerThread: true, hasAttachments: true, needsBootstrap: false }),
    ).toBe(false);
    expect(
      isOutboxEligibleSend({ isServerThread: true, hasAttachments: false, needsBootstrap: true }),
    ).toBe(false);
    expect(
      isOutboxEligibleSend({ isServerThread: false, hasAttachments: false, needsBootstrap: false }),
    ).toBe(false);
  });
});

describe("outbox flusher", () => {
  it("sends with the stored commandId and removes the message once accepted", async () => {
    const cmd = enqueue(ENV_A, command());
    const sent: OutboxTurnStartCommand[] = [];
    const gate = deferred();
    const deps: OutboxFlushDeps = {
      isLinkUp: () => true,
      dispatch: (_env, c) => {
        sent.push(c);
        return gate.promise;
      },
    };
    const pass = flushOutboxOnce(deps);
    expect(statuses()).toEqual(["sending"]);
    // A second pass while it is in flight does not send it again.
    void flushOutboxOnce(deps);
    expect(sent).toHaveLength(1);
    gate.resolve();
    await pass;
    expect(sent[0]?.commandId).toBe(cmd.commandId);
    expect(useOutboxStore.getState().entries).toEqual([]);
  });

  it("puts a message back in line when the link drops under it, then resends the same command", async () => {
    const cmd = enqueue(ENV_A, command());
    const sent: string[] = [];
    let fail = true;
    const deps: OutboxFlushDeps = {
      isLinkUp: () => true,
      dispatch: (_env, c) => {
        sent.push(c.commandId);
        return fail ? Promise.reject(new TransportConnectionLostError()) : Promise.resolve();
      },
    };
    await flushOutboxOnce(deps);
    expect(statuses()).toEqual(["waiting"]);
    expect(useOutboxStore.getState().entries[0]?.error).toBeNull();

    // Cooldown: an immediate pass does not hammer the dead link.
    await flushOutboxOnce(deps);
    expect(sent).toHaveLength(1);

    resetOutboxFlusherForTests();
    fail = false;
    await flushOutboxOnce(deps);
    expect(sent).toEqual([cmd.commandId, cmd.commandId]);
    expect(useOutboxStore.getState().entries).toEqual([]);
  });

  it("marks a server rejection as failed with its message", async () => {
    enqueue(ENV_A, command());
    await flushOutboxOnce({
      isLinkUp: () => true,
      dispatch: () => Promise.reject(new Error("Thread is archived")),
    });
    expect(useOutboxStore.getState().entries[0]).toMatchObject({
      status: "failed",
      error: "Thread is archived",
    });
  });

  it("waits while the computer is unreachable or has no API yet", async () => {
    enqueue(ENV_A, command());
    let dispatched = 0;
    await flushOutboxOnce({
      isLinkUp: () => false,
      dispatch: () => {
        dispatched += 1;
        return Promise.resolve();
      },
    });
    await flushOutboxOnce({ isLinkUp: () => true, dispatch: () => undefined });
    expect(dispatched).toBe(0);
    expect(statuses()).toEqual(["waiting"]);
  });

  it("a send interrupted by a reload is retried", async () => {
    const cmd = enqueue(ENV_A, command());
    useOutboxStore.getState().markSending(cmd.message.messageId);
    // No delivery in flight in this page: the entry is put back and sent.
    const sent: string[] = [];
    await flushOutboxOnce({
      isLinkUp: () => true,
      dispatch: (_env, c) => {
        sent.push(c.commandId);
        return Promise.resolve();
      },
    });
    expect(sent).toEqual([cmd.commandId]);
  });
});
