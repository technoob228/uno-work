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

/** A Telegram / Slack chat of an assistant (`assistantPush.ts` PushVia). */
export interface AssistantPushChat {
  readonly kind: "telegram" | "slack";
  readonly connectorProjectId: string;
  readonly replyKey: string;
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
   * Watch a chat the assistant started on ANOTHER computer of the account
   * (`remoteComputers/`): its status is polled there with a growing step and
   * a time cap; the outcome reaches the conversation like a local one.
   */
  readonly watchRemote: (input: {
    readonly threadId: string;
    readonly assistantProjectId: string;
    readonly conversationThreadId: string;
    readonly boxId: number;
    readonly computerName: string;
  }) => Effect.Effect<void>;
  /**
   * The Telegram / Slack chat a conversation's current turn answers to (its
   * reply still in flight), or null: the desktop. Read it while the turn
   * runs; hand it to {@link tellViaChat} later.
   */
  readonly chatOf: (threadId: ThreadId) => Effect.Effect<AssistantPushChat | null>;
  /**
   * A note for the conversation answered in that chat (the same path as a
   * work update: a system turn of the chat's reply path). False: the chat's
   * rows are gone — tell the conversation another way.
   */
  readonly tellViaChat: (input: {
    readonly threadId: ThreadId;
    readonly chat: AssistantPushChat;
    readonly text: string;
    readonly fallbackText: string;
  }) => Effect.Effect<boolean>;
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
