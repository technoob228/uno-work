/**
 * "Hand to…" across computers (T63-C): both sides in one test — the chat's
 * computer ("Mac": `makeHandedRemotePush`) talks to the handler's computer
 * ("uno-work": `makeHandedHost`) through a fake of the console pairing that
 * calls the host's handlers directly, like the routes do.
 */
import {
  type OrchestrationCommand,
  type OrchestrationCommandOrigin,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Logger, Option, References } from "effect";
import { describe, expect, it } from "vitest";

import {
  crossComputerRefusal,
  makeHandedRemotePush,
  HANDED_PULL_EVERY_MS,
} from "../manager/handedRemotePush.ts";
import { EMPTY_PUSH_STATE, type PushState, watchHanded } from "../manager/assistantPush.ts";
import {
  applyLetter,
  applyPull,
  HANDED_CHATS_PATH,
  HANDED_OUTBOX_LIMIT,
  handlerHereRefusal,
  makeHandedHost,
  pullHanded,
  sendHandedLetter,
  type HandedInLedger,
  type HandedLetterInput,
  type HandedPullInput,
} from "./handedRemote.ts";
import { remoteError, type RemoteComputerError } from "./remoteDaemonClient.ts";

const T0 = "2026-11-26T10:00:00.000Z";
const UNO_WORK = { boxId: 2531, name: "uno-work" };
const CHAT = "chat-on-mac" as ThreadId;
const COORD = "coordinator-on-uno-work" as ThreadId;

const thread = (id: string, overrides: Partial<OrchestrationThreadShell> = {}) =>
  ({
    id: id as ThreadId,
    projectId: "project-site",
    title: id,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  }) as OrchestrationThreadShell;

const projectionsOf = (
  threads: Map<string, OrchestrationThreadShell>,
  lastAnswer = "Done: v2",
) => ({
  getThreadShellById: (id: ThreadId) => Effect.succeed(Option.fromNullishOr(threads.get(id))),
  getThreadDetailById: (id: ThreadId) =>
    Effect.succeed(
      threads.has(id)
        ? Option.some({ messages: [{ role: "assistant", text: lastAnswer }] } as never)
        : Option.none(),
    ),
  getShellSnapshot: () => Effect.succeed({ threads: [...threads.values()] } as never),
});

/** The handler's computer: its chats, its ledger, the letters queued for its handler. */
function unoWork(options: { readonly coordinator?: Partial<OrchestrationThreadShell> } = {}) {
  const threads = new Map([
    [COORD, thread(COORD, { title: "Coordinator", ...options.coordinator })],
  ]);
  let ledger: HandedInLedger = {};
  const letters: Array<{ key: string; handlerThreadId: string; text: string }> = [];
  let ids = 0;
  const host = makeHandedHost({
    projections: projectionsOf(threads) as never,
    read: Effect.sync(() => ledger),
    update: (change) =>
      Effect.sync(() => {
        const next = change(ledger);
        ledger = next.ledger;
        return next.result;
      }),
    queueLetter: (letter) => Effect.sync(() => void letters.push(letter)),
    nowMs: () => Date.parse(T0),
    newId: () => `msg-${++ids}`,
  });
  /** The console's pairing: a request from the Mac lands on this computer's routes. */
  const request = (input: {
    method: string;
    path: string;
    body?: unknown;
  }): Effect.Effect<{ readonly status: number; readonly body: unknown }, RemoteComputerError> =>
    Effect.gen(function* () {
      if (input.path === `${HANDED_CHATS_PATH}/letters`) {
        return yield* host.letter(input.body as HandedLetterInput);
      }
      const pullPath = new RegExp(`^${HANDED_CHATS_PATH}/([^/]+)/pull$`).exec(input.path);
      if (pullPath !== null) {
        return yield* host.pull(decodeURIComponent(pullPath[1]!), input.body as HandedPullInput);
      }
      return { status: 404, body: "<html>" };
    });
  return { threads, host, letters, request, ledger: () => ledger };
}

/** The chat's computer: its chat (handed to the coordinator there) and what it dispatched. */
function mac(remoteRequest: ReturnType<typeof unoWork>["request"], free = true) {
  const threads = new Map([
    [
      CHAT,
      thread(CHAT, {
        title: "Landing page",
        handler: { threadId: COORD, kind: "chat", computer: UNO_WORK, handedAt: T0 },
        agentsClosedAt: T0,
      }),
    ],
  ]);
  let state: PushState = watchHanded(EMPTY_PUSH_STATE, {
    threadId: CHAT,
    handlerThreadId: COORD,
    handlerProjectId: "",
    at: T0,
    computer: UNO_WORK,
  });
  const dispatched: Array<{ command: OrchestrationCommand; origin?: OrchestrationCommandOrigin }> =
    [];
  let chatFree = free;
  const push = makeHandedRemotePush({
    remote: {
      request: (input) => remoteRequest(input),
      self: Effect.succeed({ name: "Mac", boxId: null }),
      computerAwake: () => Effect.succeed(true),
    },
    engine: {
      dispatch: (
        command: OrchestrationCommand,
        options?: { origin?: OrchestrationCommandOrigin },
      ) =>
        Effect.sync(() => {
          dispatched.push({ command, ...(options?.origin ? { origin: options.origin } : {}) });
          return { sequence: dispatched.length };
        }),
    } as never,
    projections: projectionsOf(threads) as never,
    getState: Effect.sync(() => state),
    commit: (next) => Effect.sync(() => void (state = next)),
    chatFree: () => Effect.sync(() => chatFree),
    handledHere: Effect.succeed({}),
  });
  return {
    threads,
    push,
    dispatched,
    state: () => state,
    setFree: (value: boolean) => void (chatFree = value),
  };
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const NOW = Date.parse(T0);

const brief = (key = "brief-1") => ({
  key,
  conversationThreadId: COORD,
  text: "[Uno Work: handed to you] The person handed you the chat «Landing page» …",
  at: T0,
  remote: { computer: UNO_WORK, chatThreadId: CHAT, kind: "brief" as const },
});

describe("Hand to… across computers: the two sides together", () => {
  it("brief → registered there and queued for the handler, with the chat's status", async () => {
    const there = unoWork();
    const here = mac(there.request);
    expect(await run(here.push.deliverLetter(brief(), NOW))).toBe(true);
    expect(there.letters).toEqual([
      expect.objectContaining({
        handlerThreadId: COORD,
        text: expect.stringContaining("Landing page"),
      }),
    ]);
    expect(there.ledger()[CHAT]).toMatchObject({
      handlerThreadId: COORD,
      fromComputerName: "Mac",
      fromBoxId: null,
      status: { title: "Landing page", runtimeMode: "auto-accept-edits", lastMessage: "Done: v2" },
    });
    // The same letter again (a lost answer): queued once.
    expect(await run(here.push.deliverLetter(brief(), NOW))).toBe(true);
    expect(there.letters).toHaveLength(1);
  });

  it("the handler writes there → the Mac puts it into the chat as from the handler, once", async () => {
    const there = unoWork();
    const here = mac(there.request);
    await run(here.push.deliverLetter(brief(), NOW));
    const sent = await run(
      there.host.sendFromHandler({
        callerThreadId: COORD,
        callerRuntimeMode: "full-access",
        chatThreadId: CHAT,
        text: "Ship the hero section first",
      }),
    );
    expect(sent).toMatchObject({ status: 200, body: { relation: "handed", computer: "Mac" } });

    await run(here.push.pull(NOW));
    const turns = here.dispatched.filter((entry) => entry.command.type === "thread.turn.start");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      command: {
        threadId: CHAT,
        message: { text: "Ship the hero section first" },
        // Capped to the chat's own (narrower) mode.
        runtimeMode: "auto-accept-edits",
      },
      origin: { kind: "agent", threadId: COORD },
    });
    // Next pull acks it: gone from the outbox there, not dispatched twice.
    await run(here.push.pull(NOW + HANDED_PULL_EVERY_MS));
    expect(there.ledger()[CHAT]?.outbox).toEqual([]);
    expect(
      here.dispatched.filter((entry) => entry.command.type === "thread.turn.start"),
    ).toHaveLength(1);
  });

  it("a busy chat takes the handler's message on a later pull", async () => {
    const there = unoWork();
    const here = mac(there.request, false);
    await run(here.push.deliverLetter(brief(), NOW));
    await run(
      there.host.sendFromHandler({
        callerThreadId: COORD,
        callerRuntimeMode: "full-access",
        chatThreadId: CHAT,
        text: "next",
      }),
    );
    await run(here.push.pull(NOW));
    expect(here.dispatched).toEqual([]);
    here.setFree(true);
    await run(here.push.pull(NOW + HANDED_PULL_EVERY_MS));
    expect(here.dispatched.map((entry) => entry.command.type)).toEqual(["thread.turn.start"]);
  });

  it("the handler deleted there → the chat comes back to the person", async () => {
    const there = unoWork();
    const here = mac(there.request);
    await run(here.push.deliverLetter(brief(), NOW));
    there.threads.set(COORD, thread(COORD, { archivedAt: T0 }));
    await run(here.push.pull(NOW));
    expect(here.dispatched).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({
          type: "thread.handler.set",
          threadId: CHAT,
          handler: null,
          reason: "handler-gone",
        }),
      }),
    ]);
    expect(there.ledger()[CHAT]).toBeUndefined();
  });

  it("an update for a handler gone there gives the chat back too", async () => {
    const there = unoWork();
    const here = mac(there.request);
    await run(here.push.deliverLetter(brief(), NOW));
    there.threads.delete(COORD);
    const done = await run(
      here.push.deliverLetter(
        { ...brief("wrote-1"), remote: { ...brief().remote, kind: "update" } },
        NOW,
      ),
    );
    expect(done).toBe(true);
    expect(here.dispatched[0]?.command).toMatchObject({
      type: "thread.handler.set",
      reason: "handler-gone",
    });
  });

  it("a handler there that is itself handed to another computer refuses the brief", async () => {
    const there = unoWork({
      coordinator: {
        handler: {
          threadId: "elsewhere" as ThreadId,
          kind: "chat",
          computer: { boxId: 9, name: "z" },
          handedAt: T0,
        },
      },
    });
    const here = mac(there.request);
    expect(await run(here.push.deliverLetter(brief(), NOW))).toBe(true);
    expect(there.letters).toEqual([]);
    expect(here.dispatched.map((entry) => entry.command.type)).toEqual([
      "thread.handler.set",
      "thread.person.call",
    ]);
    expect(here.dispatched[1]?.command).toMatchObject({
      reason: expect.stringContaining("is itself handed to another computer"),
    });
    // Its "taken back" letter isn't owed.
    expect(here.push.takeRefused(CHAT)).toBe(true);
  });

  it("an unreachable computer keeps the letter for a minute later", async () => {
    const here = mac(() => Effect.fail(remoteError("unreachable", "asleep")));
    expect(await run(here.push.deliverLetter(brief(), NOW))).toBe(false);
    // Within the minute it isn't even tried.
    expect(await run(here.push.deliverLetter(brief(), NOW + 1_000))).toBe(false);
  });

  it("a letter that doesn't get through is logged with how long it waits, and when it lands", async () => {
    const there = unoWork();
    let reachable = false;
    const here = mac((input) =>
      reachable ? there.request(input) : Effect.fail(remoteError("unreachable", "asleep")),
    );
    const logs: Array<{ message: string; notes: Record<string, unknown> }> = [];
    const logger = Logger.make<unknown, void>((options) => {
      logs.push({
        message: String(Array.isArray(options.message) ? options.message[0] : options.message),
        notes: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
      });
    });
    const logged = <A, E>(effect: Effect.Effect<A, E>) =>
      run(effect.pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))));

    expect(await logged(here.push.deliverLetter(brief(), NOW))).toBe(false);
    expect(await logged(here.push.deliverLetter(brief(), NOW + 61_000))).toBe(false);
    reachable = true;
    expect(await logged(here.push.deliverLetter(brief(), NOW + 180_000))).toBe(true);

    const retries = logs.filter((log) => log.message.includes("didn't take a letter"));
    expect(retries.map((log) => log.notes.undeliveredMinutes)).toEqual([0, 1]);
    expect(retries[0]!.notes).toMatchObject({ boxId: UNO_WORK.boxId, kind: "brief", retryInSeconds: 60 });
    const landed = logs.find((log) => log.message.includes("got through after retries"));
    expect(landed?.notes).toMatchObject({ boxId: UNO_WORK.boxId, undeliveredMinutes: 3 });
  });

  it("taken back → 'off' forgets the chat there", async () => {
    const there = unoWork();
    const here = mac(there.request);
    await run(here.push.deliverLetter(brief(), NOW));
    await run(
      here.push.deliverLetter(
        { ...brief("off-1"), remote: { ...brief().remote, kind: "off" } },
        NOW,
      ),
    );
    expect(there.ledger()[CHAT]).toBeUndefined();
    expect(there.letters).toHaveLength(2);
    // Writing there afterwards: not a chat of this handler any more.
    expect(
      await run(
        there.host.sendFromHandler({
          callerThreadId: COORD,
          callerRuntimeMode: "full-access",
          chatThreadId: CHAT,
          text: "late",
        }),
      ),
    ).toBeNull();
  });
});

describe("the handler's computer", () => {
  const letter = (overrides: Partial<HandedLetterInput> = {}): HandedLetterInput => ({
    handlerThreadId: COORD,
    chat: { threadId: CHAT, title: "Landing page" },
    from: { computerName: "Mac", boxId: null },
    kind: "brief",
    key: "k1",
    text: "brief",
    ...overrides,
  });

  it("only the chat's own handler writes there, never wider than the chat runs", async () => {
    const there = unoWork();
    await run(
      there.host.letter(
        letter({
          status: {
            title: "Landing page",
            state: "idle",
            lastMessage: null,
            runtimeMode: "full-access",
            updatedAt: T0,
          },
        }),
      ),
    );
    expect(
      await run(
        there.host.sendFromHandler({
          callerThreadId: "someone-else",
          callerRuntimeMode: "full-access",
          chatThreadId: CHAT,
          text: "hi",
        }),
      ),
    ).toBeNull();
    expect(
      await run(
        there.host.sendFromHandler({
          callerThreadId: COORD,
          callerRuntimeMode: "approval-required",
          chatThreadId: CHAT,
          text: "hi",
        }),
      ),
    ).toMatchObject({ status: 403, body: { error: "runtime_mode_escalation" } });
  });

  it("chat_status of the handed chat is the status its computer brought", async () => {
    const there = unoWork();
    await run(
      there.host.letter(
        letter({
          status: {
            title: "Landing page",
            state: "completed",
            lastMessage: "Done: v2",
            runtimeMode: "full-access",
            updatedAt: T0,
          },
        }),
      ),
    );
    expect(
      await run(there.host.statusForHandler({ callerThreadId: COORD, chatThreadId: CHAT })),
    ).toMatchObject({
      status: 200,
      body: { computer: "Mac", status: "completed", lastAssistantMessage: "Done: v2" },
    });
    expect(
      await run(there.host.statusForHandler({ callerThreadId: "other", chatThreadId: CHAT })),
    ).toBeNull();
  });

  it("holds at most a few unread messages", async () => {
    const there = unoWork();
    await run(there.host.letter(letter()));
    for (let index = 0; index < HANDED_OUTBOX_LIMIT; index += 1) {
      await run(
        there.host.sendFromHandler({
          callerThreadId: COORD,
          callerRuntimeMode: "full-access",
          chatThreadId: CHAT,
          text: `m${index}`,
        }),
      );
    }
    expect(
      await run(
        there.host.sendFromHandler({
          callerThreadId: COORD,
          callerRuntimeMode: "full-access",
          chatThreadId: CHAT,
          text: "one more",
        }),
      ),
    ).toMatchObject({ status: 409, body: { error: "target_busy" } });
  });

  it("an update about a chat it never got: not_handling", async () => {
    const there = unoWork();
    expect(await run(there.host.letter(letter({ kind: "update", key: "u1" })))).toMatchObject({
      status: 409,
      body: { error: "not_handling" },
    });
  });

  it("re-handed to another chat there: the old handler's unread messages don't follow", () => {
    let ledger: HandedInLedger = {};
    ledger = applyLetter(ledger, letter(), T0).ledger;
    ledger = {
      ...ledger,
      [CHAT]: {
        ...ledger[CHAT]!,
        outbox: [{ id: "m", text: "x", at: T0, runtimeMode: "full-access" }],
      },
    };
    const next = applyLetter(ledger, letter({ handlerThreadId: "other", key: "k2" }), T0).ledger;
    expect(next[CHAT]).toMatchObject({ handlerThreadId: "other", outbox: [] });
    expect(applyPull(next, CHAT, { handlerThreadId: COORD, ack: [] }, T0).result).toBeNull();
  });

  it("depth: a handler two hops down takes no more chats of other computers", () => {
    const a = thread("a", { handler: { threadId: "b" as ThreadId, kind: "chat", handedAt: T0 } });
    const b = thread("b", { handler: { threadId: "c" as ThreadId, kind: "chat", handedAt: T0 } });
    const c = thread("c");
    expect(handlerHereRefusal({ handler: b, threads: [a, b, c] })).toBeNull();
    const d = thread("d", { handler: { threadId: "a" as ThreadId, kind: "chat", handedAt: T0 } });
    expect(handlerHereRefusal({ handler: d, threads: [a, b, c, d] })?.error).toBe(
      "handler_too_deep",
    );
  });
});

describe("rules only the ledger of chats from elsewhere knows", () => {
  const ledger: HandedInLedger = {
    [CHAT]: {
      chatThreadId: CHAT,
      title: "Landing page",
      fromComputerName: "Mac",
      fromBoxId: null,
      handlerThreadId: COORD,
      handedAt: T0,
      seenAt: T0,
      status: null,
      outbox: [],
      keys: [],
    },
  };

  it("a chat handling chats of other computers isn't handed to another computer", () => {
    expect(
      crossComputerRefusal({
        threads: [thread(COORD)],
        threadId: COORD,
        handler: { threadId: "x", computer: { boxId: 2534, name: "canary" } },
        ledger,
      }),
    ).toMatch(/stays on this computer/);
  });

  it("...and here counts those chats as one hop down", () => {
    // up → mid → top: handing the coordinator to mid is 1 + 1 + 1; to up, 1 + 1 + 2.
    const up = thread("up", {
      handler: { threadId: "mid" as ThreadId, kind: "chat", handedAt: T0 },
    });
    const mid = thread("mid", {
      handler: { threadId: "top" as ThreadId, kind: "chat", handedAt: T0 },
    });
    const threads = [thread(COORD), up, mid, thread("top")];
    expect(
      crossComputerRefusal({ threads, threadId: COORD, handler: { threadId: "mid" }, ledger }),
    ).toBeNull();
    expect(
      crossComputerRefusal({ threads, threadId: COORD, handler: { threadId: "up" }, ledger }),
    ).toMatch(/at most 3 levels/);
  });
});

describe("the calls to the handler's computer", () => {
  const reply = (status: number, body: unknown) => () => Effect.succeed({ status, body });
  const letterBody = {
    handlerThreadId: COORD,
    chat: { threadId: CHAT, title: "t" },
    from: { computerName: "Mac", boxId: null },
    kind: "update" as const,
    key: "k",
    text: "x",
  };

  it("reads an older Uno Work there as 'too old', a 410 as gone, a 5xx as try later", async () => {
    expect(await run(sendHandedLetter(reply(404, "<html>"), UNO_WORK, letterBody))).toMatchObject({
      kind: "refused",
      message: expect.stringContaining("too old"),
    });
    expect(
      await run(
        sendHandedLetter(reply(410, { ok: false, error: "handler_gone" }), UNO_WORK, letterBody),
      ),
    ).toMatchObject({ kind: "gone" });
    const failed = await Effect.runPromise(
      Effect.flip(sendHandedLetter(reply(503, null), UNO_WORK, letterBody)),
    );
    expect(failed.code).toBe("unreachable");
  });

  it("drops malformed messages of a pull and narrows an unknown mode", async () => {
    const result = await run(
      pullHanded(
        reply(200, {
          handler: "active",
          handlerTitle: "Coordinator",
          messages: [
            { id: "1", text: "ok", at: T0, runtimeMode: "weird" },
            { id: 2 },
            { id: "3", text: "" },
          ],
        }),
        UNO_WORK,
        CHAT,
        { handlerThreadId: COORD, ack: [] },
      ),
    );
    expect(result?.messages).toEqual([
      { id: "1", text: "ok", at: T0, runtimeMode: "approval-required" },
    ]);
  });
});
