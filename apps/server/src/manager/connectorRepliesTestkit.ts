/**
 * Test kit for the connector reply watcher (`connectorReplies.ts`): a clock
 * that runs 60× faster than the wall clock and a fake harness that runs one
 * prompt at a time (like hermes' prompt lock), writing what the projections
 * would show — messages, the session, turn rows, a pre-tool chunk and a tool
 * activity per turn. Not a test file itself; the Telegram and Slack live
 * tests share it.
 */
import {
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { Clock, Duration, Effect } from "effect";

import { ORPHANED_PROVIDER_SESSION_ERROR } from "../orchestration/orphanedSession.ts";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";

// ── Time: 1 real second is a virtual minute ─────────────────────────────

export const SPEED = 60;
const realStart = Date.now();
export const virtualNow = () => realStart + (Date.now() - realStart) * SPEED;
export const fastClock: Clock.Clock = {
  currentTimeMillisUnsafe: virtualNow,
  currentTimeMillis: Effect.sync(virtualNow),
  currentTimeNanosUnsafe: () => BigInt(virtualNow()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(virtualNow()) * 1_000_000n),
  sleep: (duration) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(resolve, Math.max(1, Duration.toMillis(duration) / SPEED)),
        ),
    ),
};
export const iso = () => new Date(virtualNow()).toISOString();
export const MINUTE = 60_000;
/** Real ms for a virtual span. */
export const real = (virtualMs: number) => virtualMs / SPEED;

// ── Fake harness: one prompt at a time, like hermes' prompt lock ─────────

export interface Script {
  readonly durationMs: number;
  readonly answer: string;
}

export class World {
  /** The thread the harness runs in (Telegram: the main conversation). */
  threadId: ThreadId | null = null;
  messages: Array<OrchestrationThread["messages"][number]> = [];
  activities: Array<OrchestrationThread["activities"][number]> = [];
  session: OrchestrationThread["session"] = null;
  queue: Array<{ messageId: string; text: string }> = [];
  running: { turnId: string; messageId: string; endsAtMs: number; answer: string } | null = null;
  turnCount = 0;
  dispatchedTexts: Array<string> = [];
  turns: ProjectionTurnRepositoryShape | null = null;
  script: (text: string) => Script = (text) => ({ durationMs: 30_000, answer: `ответ: ${text}` });
  private timer: ReturnType<typeof setInterval> | null = null;

  start() {
    this.timer = setInterval(() => void this.step(), 10);
  }
  stop() {
    if (this.timer !== null) clearInterval(this.timer);
  }

  private setSession(status: string, activeTurnId: string | null, lastError: string | null = null) {
    this.session = {
      threadId: this.threadId ?? ThreadId.make("unknown"),
      status: status as "ready",
      providerName: "hermes",
      runtimeMode: "full-access",
      activeTurnId: activeTurnId === null ? null : TurnId.make(activeTurnId),
      lastError,
      updatedAt: iso(),
    };
  }

  private upsertTurn(turnId: string, messageId: string, state: "running" | "completed") {
    const at = iso();
    return this.turns === null
      ? Promise.resolve()
      : Effect.runPromise(
          this.turns
            .upsertByTurnId({
              threadId: this.threadId ?? ThreadId.make("unknown"),
              turnId: TurnId.make(turnId),
              pendingMessageId: MessageId.make(messageId),
              sourceProposedPlanThreadId: null,
              sourceProposedPlanId: null,
              assistantMessageId: null,
              state,
              requestedAt: at,
              startedAt: at,
              completedAt: state === "completed" ? at : null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            })
            .pipe(Effect.ignore),
        );
  }

  private async step() {
    const now = virtualNow();
    if (this.running !== null && now >= this.running.endsAtMs) {
      const done = this.running;
      this.running = null;
      this.messages.push({
        id: MessageId.make(`answer-${done.turnId}`),
        role: "assistant",
        text: done.answer,
        turnId: TurnId.make(done.turnId),
        streaming: false,
        createdAt: iso(),
        updatedAt: iso(),
      });
      await this.upsertTurn(done.turnId, done.messageId, "completed");
      this.setSession("ready", null);
      return;
    }
    if (this.running === null && this.queue.length > 0) {
      const next = this.queue.shift()!;
      const turnId = `turn-${++this.turnCount}`;
      const script = this.script(next.text);
      this.running = {
        turnId,
        messageId: next.messageId,
        endsAtMs: now + script.durationMs,
        answer: script.answer,
      };
      this.setSession("running", turnId);
      await this.upsertTurn(turnId, next.messageId, "running");
      // A hermes pre-tool chunk, finished, then a tool call.
      this.messages.push({
        id: MessageId.make(`chunk-${turnId}`),
        role: "assistant",
        text: "Сейчас посмотрю…",
        turnId: TurnId.make(turnId),
        streaming: false,
        createdAt: iso(),
        updatedAt: iso(),
      });
      this.activities.push({
        id: `activity-${turnId}` as never,
        tone: "tool",
        kind: "tool.started",
        summary: "Running a command",
        payload: {},
        turnId: TurnId.make(turnId),
        createdAt: iso(),
      });
    }
  }

  /** What startup reconciliation does to a live session after a restart. */
  restart() {
    const wasRunning = this.running !== null;
    this.running = null;
    this.queue = [];
    if (wasRunning) this.setSession("error", null, ORPHANED_PROVIDER_SESSION_ERROR);
  }

  dispatch(command: OrchestrationCommand) {
    if (command.type === "thread.create") this.threadId = command.threadId;
    if (command.type === "thread.turn.start") {
      this.threadId = command.threadId;
      this.dispatchedTexts.push(command.message.text);
      this.messages.push({
        id: command.message.messageId,
        role: "user",
        text: command.message.text,
        turnId: null,
        streaming: false,
        createdAt: iso(),
        updatedAt: iso(),
      });
      this.queue.push({ messageId: command.message.messageId, text: command.message.text });
    }
  }

  detail(): OrchestrationThread {
    return {
      id: this.threadId,
      messages: this.messages,
      activities: this.activities,
      session: this.session,
    } as unknown as OrchestrationThread;
  }
}

export const waitFor = (check: () => boolean, realMs: number) =>
  Effect.promise(async () => {
    const until = Date.now() + realMs;
    while (!check() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    return check();
  });
