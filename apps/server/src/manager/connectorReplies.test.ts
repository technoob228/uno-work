import { describe, expect, it } from "@effect/vitest";
import { MessageId, TurnId } from "@t3tools/contracts";

import { ORPHANED_PROVIDER_SESSION_ERROR } from "../orchestration/orphanedSession.ts";
import {
  decidePendingReply,
  LOST_TURN_MS,
  NO_TEXT_GRACE_MS,
  SETTLE_QUIET_MS,
  type ReplyProbe,
  type ReplyProbeMessage,
} from "./connectorReplies.ts";

const T0 = Date.parse("2026-10-09T00:37:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const userMessage = (id: string, seconds: number): ReplyProbeMessage => ({
  id,
  role: "user",
  text: "question",
  streaming: false,
  turnId: null,
  createdAt: at(seconds),
  updatedAt: at(seconds),
});

const assistant = (
  id: string,
  turnId: string,
  seconds: number,
  text: string,
  streaming = false,
): ReplyProbeMessage => ({
  id,
  role: "assistant",
  text,
  streaming,
  turnId,
  createdAt: at(seconds),
  updatedAt: at(seconds),
});

const turn = (
  turnId: string | null,
  pendingMessageId: string | null,
  state: "pending" | "running" | "completed" | "interrupted" | "error",
  requestedSeconds: number,
  completedSeconds: number | null = null,
) => ({
  turnId: turnId === null ? null : TurnId.make(turnId),
  pendingMessageId: pendingMessageId === null ? null : MessageId.make(pendingMessageId),
  state,
  requestedAt: at(requestedSeconds),
  completedAt: completedSeconds === null ? null : at(completedSeconds),
});

const probe = (overrides: Partial<ReplyProbe>): ReplyProbe => ({
  userMessageId: "m1",
  requestedAt: at(0),
  knownTurnId: null,
  claimedTurnIds: new Set(),
  messages: [userMessage("m1", 0)],
  turns: [],
  session: { status: "ready", activeTurnId: null, updatedAt: at(0), lastError: null },
  activities: [],
  nowMs: T0 + 60_000,
  ...overrides,
});

const running = (turnId: string, seconds: number) => ({
  status: "running",
  activeTurnId: turnId,
  updatedAt: at(seconds),
  lastError: null,
});
const ready = (seconds: number) => ({
  status: "ready",
  activeTurnId: null,
  updatedAt: at(seconds),
  lastError: null,
});
const tool = (turnId: string, seconds: number) => ({
  kind: "tool.started",
  turnId,
  createdAt: at(seconds),
  payload: {},
});

describe("decidePendingReply", () => {
  it("waits while the session runs the turn, though hermes already marked it completed on a pre-tool chunk", () => {
    const messages = [userMessage("m1", 0), assistant("a1", "t1", 5, "Сейчас посмотрю…")];
    expect(
      decidePendingReply(
        probe({
          messages,
          turns: [turn("t1", "m1", "completed", 0, 5)],
          session: running("t1", 1),
          activities: [tool("t1", 6)],
        }),
      ),
    ).toEqual({ kind: "wait", turnId: "t1" });

    const done = decidePendingReply(
      probe({
        messages: [...messages, assistant("a2", "t1", 900, "Итоговый ответ")],
        turns: [turn("t1", "m1", "completed", 0, 900)],
        session: ready(900),
        activities: [tool("t1", 6)],
        nowMs: T0 + 905_000,
      }),
    );
    expect(done).toEqual({ kind: "answer", turnId: "t1", text: "Итоговый ответ", files: [] });
  });

  it("never waits on a clock: a turn running for hours is still awaited", () => {
    expect(
      decidePendingReply(
        probe({
          turns: [turn("t1", "m1", "running", 0)],
          session: running("t1", 1),
          nowMs: T0 + 5 * 3600_000,
        }),
      ),
    ).toEqual({ kind: "wait", turnId: "t1" });
  });

  it("answers each message with its own turn — the late answer of the first never goes to the second", () => {
    // 00:37 m1 → t1 (long); 00:40 m2 arrives and is queued; t1's answer lands
    // at 01:10, after m2 was requested. The old time-based matcher handed
    // that answer to m2 ("невпопад").
    const messages = [
      userMessage("m1", 0),
      userMessage("m2", 180),
      assistant("a1", "t1", 1980, "answer to the first"),
    ];
    const turns = [turn("t1", "m1", "completed", 0, 1980)];
    const second = decidePendingReply(
      probe({
        userMessageId: "m2",
        requestedAt: at(180),
        claimedTurnIds: new Set(["t1"]),
        messages,
        turns,
        session: ready(1980),
        nowMs: T0 + 1990_000,
      }),
    );
    expect(second.kind).toBe("wait");

    const first = decidePendingReply(
      probe({ messages, turns, session: ready(1980), nowMs: T0 + 1990_000 }),
    );
    expect(first).toEqual({
      kind: "answer",
      turnId: "t1",
      text: "answer to the first",
      files: [],
    });
  });

  it("finds its turn through the session when the projection lost the message link", () => {
    expect(
      decidePendingReply(
        probe({
          turns: [turn("t9", null, "running", 2)],
          session: running("t9", 2),
        }),
      ),
    ).toEqual({ kind: "wait", turnId: "t9" });
    // ...but not a turn another row already answers with.
    expect(
      decidePendingReply(
        probe({
          claimedTurnIds: new Set(["t9"]),
          turns: [turn("t9", null, "running", 2)],
          session: running("t9", 2),
        }),
      ),
    ).toEqual({ kind: "wait", turnId: null });
  });

  it("extracts [[send-file: …]] markers and keeps long answers whole", () => {
    const long = "x".repeat(9000);
    const verdict = decidePendingReply(
      probe({
        messages: [
          userMessage("m1", 0),
          assistant("a1", "t1", 30, `${long}\n\n[[send-file: /tmp/report.pdf]]`),
        ],
        turns: [turn("t1", "m1", "completed", 0, 30)],
        session: ready(30),
      }),
    );
    expect(verdict).toEqual({
      kind: "answer",
      turnId: "t1",
      text: long,
      files: ["/tmp/report.pdf"],
    });
  });

  it("holds a just-settled answer for a moment, and waits while it still streams", () => {
    const base = {
      turns: [turn("t1", "m1", "completed", 0, 30)],
      session: ready(30),
    };
    expect(
      decidePendingReply(
        probe({
          ...base,
          messages: [userMessage("m1", 0), assistant("a1", "t1", 30, "answer")],
          nowMs: T0 + 30_000 + SETTLE_QUIET_MS - 1,
        }),
      ).kind,
    ).toBe("wait");
    expect(
      decidePendingReply(
        probe({
          ...base,
          messages: [userMessage("m1", 0), assistant("a1", "t1", 30, "answ", true)],
        }),
      ).kind,
    ).toBe("wait");
  });

  it("waits for hermes' late final text when the turn worked on after its last message", () => {
    const messages = [userMessage("m1", 0), assistant("a1", "t1", 5, "Сейчас посмотрю…")];
    const base = {
      turns: [turn("t1", "m1", "completed", 0, 5)],
      session: ready(60),
      activities: [tool("t1", 6)],
    };
    expect(decidePendingReply(probe({ ...base, messages, nowMs: T0 + 70_000 })).kind).toBe("wait");
    expect(
      decidePendingReply(
        probe({
          ...base,
          messages: [...messages, assistant("a2", "t1", 72, "Вот ответ")],
          nowMs: T0 + 80_000,
        }),
      ),
    ).toEqual({ kind: "answer", turnId: "t1", text: "Вот ответ", files: [] });
  });

  it("re-runs a turn the daemon restart cut off — never sends its pre-tool chunk as the answer", () => {
    const verdict = decidePendingReply(
      probe({
        messages: [userMessage("m1", 0), assistant("a1", "t1", 5, "Сейчас посмотрю…")],
        turns: [turn("t1", "m1", "running", 0)],
        session: {
          status: "error",
          activeTurnId: null,
          updatedAt: at(700),
          lastError: ORPHANED_PROVIDER_SESSION_ERROR,
        },
        activities: [tool("t1", 6)],
        nowMs: T0 + 701_000,
      }),
    );
    expect(verdict).toEqual({
      kind: "lost",
      turnId: "t1",
      reason: ORPHANED_PROVIDER_SESSION_ERROR,
    });
  });

  it("re-runs a turn whose harness crashed mid-work", () => {
    expect(
      decidePendingReply(
        probe({
          messages: [userMessage("m1", 0), assistant("a1", "t1", 5, "Сейчас посмотрю…")],
          turns: [turn("t1", "m1", "running", 0)],
          session: { status: "stopped", activeTurnId: null, updatedAt: at(40), lastError: null },
          activities: [tool("t1", 6)],
        }),
      ).kind,
    ).toBe("lost");
  });

  it("delivers the answer of a turn that finished before its session was stopped", () => {
    expect(
      decidePendingReply(
        probe({
          messages: [userMessage("m1", 0), assistant("a1", "t1", 20, "готово, вот итог")],
          turns: [turn("t1", "m1", "completed", 0, 20)],
          session: { status: "stopped", activeTurnId: null, updatedAt: at(600), lastError: null },
          activities: [tool("t1", 6)],
          nowMs: T0 + 601_000,
        }),
      ),
    ).toEqual({ kind: "answer", turnId: "t1", text: "готово, вот итог", files: [] });
  });

  it("reports a provider failure honestly instead of re-running it", () => {
    expect(
      decidePendingReply(
        probe({
          turns: [turn("t1", "m1", "running", 0)],
          session: {
            status: "error",
            activeTurnId: null,
            updatedAt: at(10),
            lastError: "AI hours are used up",
          },
        }),
      ),
    ).toEqual({ kind: "failed", turnId: "t1", reason: "AI hours are used up" });
  });

  it("keeps waiting when the dead session status predates the request (it is being restarted)", () => {
    expect(
      decidePendingReply(
        probe({
          turns: [turn(null, "m1", "pending", 0)],
          session: { status: "stopped", activeTurnId: null, updatedAt: at(-3600), lastError: null },
          nowMs: T0 + 2_000,
        }),
      ).kind,
    ).toBe("wait");
  });

  it("gives a turn with no text the grace for a late message, then answers Done", () => {
    const base = { turns: [turn("t1", "m1", "completed", 0, 10)], session: ready(10) };
    expect(decidePendingReply(probe({ ...base, nowMs: T0 + 12_000 })).kind).toBe("wait");
    expect(
      decidePendingReply(probe({ ...base, nowMs: T0 + 10_000 + NO_TEXT_GRACE_MS + 1 })),
    ).toEqual({ kind: "answer", turnId: "t1", text: "", files: [] });
  });

  it("says the turn was stopped when the person interrupted it in the app", () => {
    expect(
      decidePendingReply(
        probe({
          turns: [turn("t1", "m1", "interrupted", 0, 10)],
          session: ready(10),
          nowMs: T0 + 10_000 + NO_TEXT_GRACE_MS + 1,
        }),
      ),
    ).toEqual({ kind: "stopped", turnId: "t1", partial: null });
  });

  it("calls a turn that never started lost after a few idle minutes", () => {
    expect(decidePendingReply(probe({ nowMs: T0 + LOST_TURN_MS - 1 })).kind).toBe("wait");
    expect(decidePendingReply(probe({ nowMs: T0 + LOST_TURN_MS + 1 }))).toEqual({
      kind: "lost",
      turnId: null,
      reason: "the turn never started",
    });
  });

  it("reports a turn that failed to start", () => {
    expect(
      decidePendingReply(
        probe({
          activities: [
            {
              kind: "provider.turn.start.failed",
              turnId: null,
              createdAt: at(1),
              payload: { detail: "No AI provider is signed in." },
            },
          ],
        }),
      ),
    ).toEqual({ kind: "failed", turnId: null, reason: "No AI provider is signed in." });
  });

  it("ignores everything from before the request", () => {
    expect(
      decidePendingReply(
        probe({
          requestedAt: at(100),
          messages: [assistant("a0", "t0", 50, "stale answer"), userMessage("m1", 100)],
          turns: [turn("t0", "m0", "completed", 0, 50)],
          session: ready(50),
          nowMs: T0 + 110_000,
        }),
      ).kind,
    ).toBe("wait");
  });
});
