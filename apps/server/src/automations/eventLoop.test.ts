import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { Deferred, Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AssistantTurnError,
  type AssistantEventTurnInput,
  type AssistantEventTurnResult,
  type ChatTurnInput,
  type ChatTurnResult,
} from "../assistants/scheduledTurn.ts";
import {
  AutomationClientError,
  type AutomationEvent,
  type AutomationResultBody,
  type ClaimOutcome,
} from "./consoleClient.ts";
import {
  IDLE_RECHECK_MS,
  laneOf,
  makeAutomationEventLoop,
  makeFileJournal,
  makeMemoryJournal,
  nextPollDelayMs,
  parseProcessed,
  resultOfTurn,
  type ProcessedJournal,
} from "./eventLoop.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const event = (id: number, overrides: Partial<AutomationEvent> = {}): AutomationEvent => ({
  id,
  automationId: 7,
  assistant: "assistant-ada",
  assistantName: "Ada",
  name: "Review PRs in getuno/x",
  instruction: "Review the PR and leave a comment",
  executor: { kind: "assistant" },
  kind: "github.pull_request",
  title: `PR #${id}`,
  url: null,
  payload: { repo: "getuno/x", number: id, title: "Fix", action: "opened", head_sha: "abcdef0" },
  createdAt: "2026-10-28T10:00:00Z",
  ...overrides,
});

interface World {
  queue: AutomationEvent[];
  eventsError: AutomationClientError | null;
  claims: number[];
  claimAnswer: (id: number) => ClaimOutcome | AutomationClientError;
  results: Array<{ id: number; body: AutomationResultBody }>;
  turns: AssistantEventTurnInput[];
  assistants: Record<string, string>;
  linked: boolean;
  polls: number;
}

function stand(
  options: {
    journal?: ProcessedJournal;
    runTurn?: (
      input: AssistantEventTurnInput,
    ) => Effect.Effect<AssistantEventTurnResult, AssistantTurnError>;
    runChatTurn?: (input: ChatTurnInput) => Effect.Effect<ChatTurnResult, AssistantTurnError>;
  } = {},
) {
  const world: World = {
    queue: [],
    eventsError: null,
    claims: [],
    claimAnswer: () => "claimed",
    results: [],
    turns: [],
    assistants: { "assistant-ada": "Ada", "assistant-home": "Uno" },
    linked: true,
    polls: 0,
  };
  const journal = options.journal ?? makeMemoryJournal();
  const loop = Effect.runSync(
    makeAutomationEventLoop({
      client: {
        events: ({ after }) =>
          Effect.suspend(() => {
            world.polls += 1;
            if (world.eventsError) return Effect.fail(world.eventsError);
            return Effect.succeed(world.queue.filter((e) => e.id > after));
          }),
        claim: (id) =>
          Effect.suspend(() => {
            world.claims.push(id);
            const answer = world.claimAnswer(id);
            return answer instanceof AutomationClientError
              ? Effect.fail(answer)
              : Effect.succeed(answer);
          }),
        result: (id, body) => Effect.sync(() => void world.results.push({ id, body })),
      },
      journal,
      linked: Effect.sync(() => world.linked),
      assistantName: (assistant) => Effect.succeed(world.assistants[assistant] ?? null),
      ...(options.runChatTurn ? { runChatTurn: options.runChatTurn } : {}),
      now: () => Date.parse("2026-10-29T09:00:00Z"),
      runTurn:
        options.runTurn ??
        ((input) =>
          Effect.sync(() => {
            world.turns.push(input);
            return {
              status: "delivered" as const,
              threadId: ThreadId.make("thread-auto"),
              delivered: 1,
              reply: "Left a review on PR #12: two nits. https://github.com/getuno/x/pull/12",
            };
          })),
    }),
  );
  return { world, loop, journal };
}

const poll = (loop: ReturnType<typeof stand>["loop"]) => Effect.runPromise(loop.pollOnce(0));

describe("automation event loop", () => {
  it("claims, wakes the assistant in its Automations thread and reports done", async () => {
    const { world, loop } = stand();
    world.queue = [event(11)];
    expect(await poll(loop)).toEqual({ kind: "events", count: 1 });
    await vi.waitFor(() => expect(world.results).toHaveLength(1));
    expect(world.claims).toEqual([11]);
    expect(world.turns).toHaveLength(1);
    expect(world.turns[0]).toMatchObject({
      projectId: "assistant-ada",
      threadTitle: "Automations",
      header: "⚙️ Review PRs in getuno/x\n\n",
      source: "automation",
    });
    expect(world.turns[0]!.prompt).toContain('[Automation "Review PRs in getuno/x"');
    expect(world.results[0]).toEqual({
      id: 11,
      body: {
        state: "done",
        summary: "Left a review on PR #12: two nits. https://github.com/getuno/x/pull/12",
        threadId: "thread-auto",
      },
    });
    expect(loop.cursor()).toBe(11);
  });

  it("a redelivered event (restart, at-least-once) runs once", async () => {
    const journal = makeMemoryJournal();
    const first = stand({ journal });
    first.world.queue = [event(11)];
    await poll(first.loop);
    await vi.waitFor(() => expect(first.world.results).toHaveLength(1));
    // The daemon restarts (cursor 0); the console lists the same event again.
    const second = stand({ journal });
    second.world.queue = [event(11), event(12)];
    await poll(second.loop);
    await vi.waitFor(() => expect(second.world.results).toHaveLength(1));
    expect(second.world.claims).toEqual([12]);
    expect(second.world.turns.map((t) => t.prompt.includes("PR #12"))).toEqual([true]);
  });

  it("claim 409: someone took it — no turn, no result, not again", async () => {
    const { world, loop, journal } = stand();
    world.claimAnswer = () => "already_claimed";
    world.queue = [event(11)];
    await poll(loop);
    await vi.waitFor(() => expect(journal.has(11)).toBe(true));
    expect(world.turns).toEqual([]);
    expect(world.results).toEqual([]);
  });

  it("a claim that didn't reach the console is retried on the next poll", async () => {
    const { world, loop } = stand();
    let fail = true;
    world.claimAnswer = () =>
      fail
        ? new AutomationClientError({ status: 502, code: "CONSOLE_UNREACHABLE", message: "down" })
        : "claimed";
    world.queue = [event(11)];
    await poll(loop);
    await vi.waitFor(() => expect(loop.inFlight()).toBe(0));
    expect(loop.cursor()).toBe(10);
    fail = false;
    await poll(loop);
    await vi.waitFor(() => expect(world.results).toHaveLength(1));
    expect(world.claims).toEqual([11, 11]);
  });

  it("the assistant isn't on this computer: failed, with a reason the person reads", async () => {
    const { world, loop } = stand();
    world.queue = [event(11, { assistant: "assistant-gone", assistantName: "Bob" })];
    await poll(loop);
    await vi.waitFor(() => expect(world.results).toHaveLength(1));
    expect(world.turns).toEqual([]);
    expect(world.results[0]!.body.state).toBe("failed");
    expect(world.results[0]!.body.reason).toContain("Bob isn't on this computer");
  });

  it("a turn that fails or times out is reported failed", () => {
    expect(resultOfTurn({ ok: false, message: "busy for 5 minutes" })).toEqual({
      state: "failed",
      reason: "busy for 5 minutes",
    });
    expect(
      resultOfTurn({
        ok: true,
        result: { status: "timeout", threadId: ThreadId.make("t"), delivered: 0, reply: null },
      }),
    ).toMatchObject({ state: "failed", threadId: "t" });
    expect(
      resultOfTurn({
        ok: true,
        result: {
          status: "no_reply",
          threadId: ThreadId.make("t"),
          delivered: 0,
          reply: "NO_REPLY",
        },
      }),
    ).toMatchObject({ state: "done", summary: expect.stringContaining("Handed off") });
  });

  it("a busy assistant (AssistantTurnError) → failed with its message", async () => {
    const { world, loop } = stand({
      runTurn: () =>
        Effect.fail(new AssistantTurnError({ status: 409, message: "The assistant was busy" })),
    });
    world.queue = [event(11)];
    await poll(loop);
    await vi.waitFor(() => expect(world.results).toHaveLength(1));
    expect(world.results[0]!.body).toEqual({ state: "failed", reason: "The assistant was busy" });
  });

  it("one event at a time per assistant; other assistants don't wait", async () => {
    const gate = Effect.runSync(Deferred.make<void>());
    const started: number[] = [];
    const { world, loop } = stand({
      runTurn: (input) =>
        Effect.gen(function* () {
          const id = Number(/PR #(\d+)/.exec(input.prompt)?.[1] ?? 0);
          started.push(id);
          if (id === 11) yield* Deferred.await(gate);
          return {
            status: "delivered" as const,
            threadId: ThreadId.make(`t-${id}`),
            delivered: 1,
            reply: `done ${id}`,
          };
        }),
    });
    world.queue = [
      event(11),
      event(12),
      event(13, { assistant: "assistant-home", assistantName: "Uno" }),
    ];
    await poll(loop);
    // Ada's second waits for her first; Uno runs meanwhile.
    await vi.waitFor(() => expect(world.results.map((r) => r.id)).toEqual([13]));
    expect(started).toEqual([11, 13]);
    Effect.runSync(Deferred.succeed(gate, undefined));
    await vi.waitFor(() => expect(world.results.map((r) => r.id)).toEqual([13, 11, 12]));
    expect(started).toEqual([11, 13, 12]);
  });

  it("idles off a cloud computer or with automations off; backs off on errors", async () => {
    const { world, loop } = stand();
    world.linked = false;
    expect(await poll(loop)).toEqual({ kind: "idle", reason: "not_linked" });
    expect(world.polls).toBe(0);
    world.linked = true;
    world.eventsError = new AutomationClientError({
      status: 404,
      code: "AUTOMATIONS_DISABLED",
      message: "off",
    });
    expect(await poll(loop)).toEqual({ kind: "idle", reason: "disabled" });
    world.eventsError = new AutomationClientError({
      status: 502,
      code: "CONSOLE_UNREACHABLE",
      message: "down",
    });
    const failed = await poll(loop);
    expect(failed.kind).toBe("error");

    expect(nextPollDelayMs({ kind: "idle", reason: "disabled" }, 0, 10)).toBe(IDLE_RECHECK_MS);
    expect(nextPollDelayMs(failed, 1, 10)).toBe(2_000);
    expect(nextPollDelayMs(failed, 2, 10)).toBe(4_000);
    expect(nextPollDelayMs(failed, 30, 10)).toBe(5 * 60_000);
    // A long-poll that held: poll again at once; an instant empty answer: pause.
    expect(nextPollDelayMs({ kind: "events", count: 0 }, 0, 25_000)).toBe(0);
    expect(nextPollDelayMs({ kind: "events", count: 0 }, 0, 20)).toBe(5_000);
    expect(nextPollDelayMs({ kind: "events", count: 2 }, 0, 20)).toBe(0);
  });
});

describe("an automation a chat runs (29.10)", () => {
  it("this chat: a new message in that chat, the answer is the summary, no assistant turn", async () => {
    const chatTurns: ChatTurnInput[] = [];
    const { world, loop } = stand({
      runChatTurn: (input) =>
        Effect.sync(() => {
          chatTurns.push(input);
          return {
            status: "answered" as const,
            threadId: "thread-7",
            reply: "3 PRs open, 1 needs you.",
          };
        }),
    });
    world.queue = [
      event(21, {
        assistant: "",
        assistantName: "",
        name: "Morning PRs",
        instruction: "List open PRs",
        executor: { kind: "chat", threadId: "thread-7" },
        kind: "schedule",
        payload: { label: "Weekdays at 09:00" },
      }),
    ];
    await poll(loop);
    await vi.waitFor(() => expect(world.results).toHaveLength(1));
    expect(world.turns).toHaveLength(0);
    expect(chatTurns[0]).toMatchObject({
      target: { kind: "chat", threadId: "thread-7" },
      reason: "automation 7",
    });
    expect(chatTurns[0]!.prompt).toMatch(
      /^\[Automation "Morning PRs" — .*Trigger: Weekdays at 09:00\.\]\nList open PRs/,
    );
    expect(world.results[0]!.body).toEqual({
      state: "done",
      summary: "3 PRs open, 1 needs you.",
      threadId: "thread-7",
    });
  });

  it("a new chat each time: titled with the name and the day", async () => {
    const chatTurns: ChatTurnInput[] = [];
    const { world, loop } = stand({
      runChatTurn: (input) =>
        Effect.sync(() => {
          chatTurns.push(input);
          return { status: "timeout" as const, threadId: "thread-new", reply: null };
        }),
    });
    world.queue = [
      event(22, {
        assistant: "",
        name: "CI check",
        executor: { kind: "new_chat", projectId: "proj-1", fromThreadId: "thread-7" },
        kind: "manual",
        payload: {},
      }),
    ];
    await poll(loop);
    await vi.waitFor(() => expect(world.results).toHaveLength(1));
    expect(chatTurns[0]!.target).toEqual({
      kind: "new_chat",
      projectId: "proj-1",
      fromThreadId: "thread-7",
      title: "CI check · Oct 29",
    });
    expect(world.results[0]!.body).toMatchObject({ state: "failed", threadId: "thread-new" });
  });

  it("an older wiring without chat turns fails the run with a note", async () => {
    const { world, loop } = stand();
    world.queue = [event(23, { assistant: "", executor: { kind: "chat", threadId: "t" } })];
    await poll(loop);
    await vi.waitFor(() => expect(world.results).toHaveLength(1));
    expect(world.results[0]!.body.state).toBe("failed");
  });

  it("lanes: per assistant, per chat, per automation for new chats", () => {
    expect(laneOf(event(1))).toBe("assistant:assistant-ada");
    expect(laneOf(event(1, { executor: { kind: "chat", threadId: "t-1" } }))).toBe("chat:t-1");
    expect(laneOf(event(1, { executor: { kind: "new_chat", projectId: "p" } }))).toBe("new_chat:7");
  });
});

describe("reporting a result", () => {
  it("retries only when the console didn't answer; a 4xx is final", async () => {
    const attempts: number[] = [];
    let answer: AutomationClientError | null = null;
    const loop = Effect.runSync(
      makeAutomationEventLoop({
        client: {
          events: () => Effect.succeed([]),
          claim: () => Effect.succeed("claimed" as const),
          result: (id) =>
            Effect.suspend(() => {
              attempts.push(id);
              return answer ? Effect.fail(answer) : Effect.void;
            }),
        },
        journal: makeMemoryJournal(),
        linked: Effect.succeed(true),
        assistantName: () => Effect.succeed("Ada"),
        runTurn: () =>
          Effect.succeed({
            status: "delivered" as const,
            threadId: ThreadId.make("t"),
            delivered: 1,
            reply: "ok",
          }),
      }),
    );
    answer = new AutomationClientError({ status: 409, code: "ALREADY_FINISHED", message: "done" });
    await Effect.runPromise(loop.processEvent(event(1)));
    expect(attempts).toEqual([1]);
    answer = new AutomationClientError({ status: 404, code: "NOT_FOUND", message: "gone" });
    await Effect.runPromise(loop.processEvent(event(2)));
    expect(attempts).toEqual([1, 2]);
    answer = new AutomationClientError({
      status: 502,
      code: "CONSOLE_UNREACHABLE",
      message: "down",
    });
    await Effect.runPromise(loop.processEvent(event(3)));
    expect(attempts).toEqual([1, 2, 3, 3, 3]);
  });
});

describe("processed journal", () => {
  it("survives a restart and keeps the last N ids", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "automations-journal-"));
    tempDirs.push(dir);
    const file = path.join(dir, "automations-processed.json");
    const journal = await Effect.runPromise(makeFileJournal(file, 3));
    for (const id of [1, 2, 3, 4]) await Effect.runPromise(journal.add(id));
    expect(journal.has(1)).toBe(false);
    expect(journal.has(4)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ids: [2, 3, 4] });
    const again = await Effect.runPromise(makeFileJournal(file, 3));
    expect(again.has(3)).toBe(true);
    expect(parseProcessed({ ids: [1, "x", -2, 5] })).toEqual([1, 5]);
    expect(parseProcessed(null)).toEqual([]);
  });
});
