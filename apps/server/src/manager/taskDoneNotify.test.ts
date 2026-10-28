import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationCommandOrigin,
  type OrchestrationEvent,
  type OrchestrationSession,
} from "@t3tools/contracts";

import {
  formatTaskDoneEmailSubject,
  formatTaskDoneText,
  formatTaskDuration,
  INITIAL_TASK_DONE_STATE,
  TASK_DONE_MIN_MS,
  trackTaskDone,
  type TaskDone,
  type TaskDoneState,
} from "./taskDoneNotify.ts";

const threadId = ThreadId.make("thread-1");
const t0 = Date.parse("2026-10-28T10:00:00.000Z");
let sequence = 0;

const base = (atMs: number, origin?: OrchestrationCommandOrigin) => ({
  sequence: ++sequence,
  eventId: EventId.make(`event-${sequence}`),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  occurredAt: new Date(atMs).toISOString(),
  commandId: CommandId.make(`command-${sequence}`),
  causationEventId: null,
  correlationId: null,
  metadata: origin === undefined ? {} : { origin },
});

const message = (atMs: number, origin?: OrchestrationCommandOrigin): OrchestrationEvent => ({
  ...base(atMs, origin),
  type: "thread.turn-start-requested",
  payload: {
    threadId,
    messageId: MessageId.make(`message-${sequence}`),
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date(atMs).toISOString(),
  },
});

const session = (
  atMs: number,
  status: OrchestrationSession["status"],
  activeTurnId: string | null = null,
): OrchestrationEvent => ({
  ...base(atMs),
  type: "thread.session-set",
  payload: {
    threadId,
    session: {
      threadId,
      status,
      providerName: "opencode",
      runtimeMode: "full-access",
      activeTurnId: activeTurnId === null ? null : TurnId.make(activeTurnId),
      lastError: null,
      updatedAt: new Date(atMs).toISOString(),
    },
  },
});

const run = (events: ReadonlyArray<OrchestrationEvent>) => {
  let state: TaskDoneState = INITIAL_TASK_DONE_STATE;
  const done: TaskDone[] = [];
  for (const event of events) {
    const next = trackTaskDone(state, event);
    state = next.state;
    if (next.done) done.push(next.done);
  }
  return { state, done };
};

const minutes = (count: number) => count * 60_000;
const system: OrchestrationCommandOrigin = {
  kind: "system",
  component: "turn-auto-retry",
  reason: "no-answer 1 of 2",
};

describe("task done notice", () => {
  it("a task of 2+ minutes the person started: one notice when it ends", () => {
    const { done, state } = run([
      message(t0),
      session(t0 + 1_000, "running", "turn-1"),
      session(t0 + minutes(8), "ready"),
    ]);
    expect(done).toEqual([{ threadId, durationMs: minutes(8) }]);
    expect(state.tasks.size).toBe(0);
  });

  it("no notice for a short turn, and nothing left over for later", () => {
    const { done, state } = run([
      message(t0),
      session(t0 + 1_000, "running", "turn-1"),
      session(t0 + TASK_DONE_MIN_MS - 1_000, "ready"),
      // An unrelated status change later must not count as a task end.
      session(t0 + minutes(10), "running", "turn-x"),
      session(t0 + minutes(11), "ready"),
    ]);
    expect(done).toEqual([]);
    expect(state.tasks.size).toBe(0);
  });

  it("the server's retry continues the task: one notice at the real end, timed from the message", () => {
    // Agent-flow pass 25.10: the turn failed on "Uno AI didn't answer"; the
    // offline-retry branch continues it with a system-origin turn.
    const { done } = run([
      message(t0),
      session(t0 + 1_000, "running", "turn-1"),
      session(t0 + minutes(9), "error"),
      message(t0 + minutes(9) + 15_000, system),
      session(t0 + minutes(9) + 16_000, "running", "turn-2"),
      session(t0 + minutes(11), "ready"),
    ]);
    expect(done).toEqual([{ threadId, durationMs: minutes(11) }]);
  });

  it("turns from a chat, an agent or an app are not the person's task", () => {
    const telegram: OrchestrationCommandOrigin = {
      kind: "connector",
      connector: "telegram",
      externalActorId: "42",
    };
    const fromChat = run([
      message(t0, telegram),
      session(t0 + 1_000, "running", "turn-1"),
      session(t0 + minutes(5), "ready"),
    ]);
    expect(fromChat.done).toEqual([]);
    // A chat taking over the thread mid-task drops the person's task.
    const takenOver = run([
      message(t0),
      session(t0 + 1_000, "running", "turn-1"),
      session(t0 + minutes(1), "ready"),
      message(t0 + minutes(2), { kind: "agent", threadId: ThreadId.make("parent") }),
      session(t0 + minutes(2) + 1_000, "running", "turn-2"),
      session(t0 + minutes(6), "ready"),
    ]);
    expect(takenOver.done).toEqual([]);
    // A scheduler's own turn without the person's task: nothing.
    const scheduled = run([
      message(t0, system),
      session(t0 + 1_000, "running", "turn-1"),
      session(t0 + minutes(5), "ready"),
    ]);
    expect(scheduled.done).toEqual([]);
  });

  it("a new message restarts the clock", () => {
    const { done } = run([
      message(t0),
      session(t0 + 1_000, "running", "turn-1"),
      session(t0 + 30_000, "ready"),
      message(t0 + minutes(20)),
      session(t0 + minutes(20) + 1_000, "running", "turn-2"),
      session(t0 + minutes(21), "ready"),
    ]);
    expect(done).toEqual([]);
  });

  it("reads as a short message with the way back", () => {
    expect(formatTaskDuration(minutes(8))).toBe("8 min");
    expect(formatTaskDuration(10_000)).toBe("1 min");
    expect(formatTaskDuration(minutes(65))).toBe("1 h 05 min");
    expect(formatTaskDuration(minutes(120))).toBe("2 h");
    expect(formatTaskDoneText({ threadTitle: "TODO API with tests", durationMs: minutes(8) })).toBe(
      'Your agent finished "TODO API with tests" (8 min). Open Uno Work to see the result: https://app.uno4.work',
    );
    expect(formatTaskDoneEmailSubject("TODO API with tests")).toBe(
      "Your agent finished: TODO API with tests",
    );
    const long = formatTaskDoneEmailSubject("x".repeat(200));
    expect(long.length).toBeLessThan(110);
  });
});
