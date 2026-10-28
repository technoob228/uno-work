/**
 * AssistantPushService — tells an assistant when work it handed off settles
 * (see `manager/assistantPush.ts`).
 *
 * @module manager/Services/AssistantPush
 */
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface AssistantPushWatched {
  readonly threadId: ThreadId;
  /** News about it is on its way to the assistant (not handed over yet). */
  readonly reportPending: boolean;
}

export interface AssistantPushServiceShape {
  /** Off by `UNO_WORK_ASSISTANT_PUSH=0`: then nothing is watched or held back. */
  readonly enabled: boolean;
  /**
   * The conversation that called `create_thread` / `send_turn` for
   * `threadId` (the MCP caller header). Call BEFORE the turn is dispatched:
   * the turn start it causes reads it.
   */
  readonly noteCaller: (input: {
    readonly threadId: ThreadId;
    readonly assistantProjectId: ProjectId;
    readonly conversationThreadId: ThreadId;
  }) => Effect.Effect<void>;
  /**
   * The assistant reports this chat's outcome to the person, so per-chat
   * "finished" / "failed" notices (Telegram forwarder, Inbox) stay quiet.
   */
  readonly reportsOutcomeOf: (threadId: ThreadId) => Effect.Effect<boolean>;
  /** Chats `assistantProjectId` is waiting on, and whether news about them is pending. */
  readonly watchedBy: (
    assistantProjectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<AssistantPushWatched>>;
}

export class AssistantPushService extends Context.Service<
  AssistantPushService,
  AssistantPushServiceShape
>()("t3/manager/Services/AssistantPushService") {}
