/**
 * ConnectorNotifyService - outbound channel from threads and software to the
 * chats bound to them (`POST /api/channels/notify`, the events forwarder).
 *
 * Resolution follows `manager/connectorBindings.ts#resolveNotifyChats`;
 * delivery goes through the connectors' own senders (retry + health
 * recording). Nothing here fails: an undeliverable chat is reported as
 * `delivered: false` in the result.
 */
import type {
  ChannelNotifyInput,
  ChannelNotifyResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ConnectorButton } from "../connectorButtons.ts";
import type { ResolvedNotifyChat } from "../connectorBindings.ts";
import type { ReplyLanguage } from "../connectorReplyText.ts";

/** A chat's message to the person (`messenger_send`, approval requests). */
export interface PersonMessageInput {
  /** The chat that speaks: its title heads the message, replies go back to it. */
  readonly threadId: ThreadId;
  readonly text: string;
  /** A file path as the agent gave it: checked like `send_file`. */
  readonly file?: string | null;
  readonly buttons?: ReadonlyArray<ReadonlyArray<ConnectorButton>> | null;
  readonly buttonsTtlMs?: number;
  readonly language?: ReplyLanguage;
  /**
   * What Slack and Uno's service bot get instead of `text` + buttons when
   * the buttons only work in Telegram (an Allow / Deny of a tool call).
   */
  readonly textWithoutButtons?: string;
  /** An approval request: not counted against the chat's message limit. */
  readonly approval?: boolean;
}

export interface PersonMessageResult {
  readonly delivered: number;
  /** Where it went: the person's Telegram / Slack, Uno's service bot, or nowhere. */
  readonly via: "telegram" | "slack" | "uno-bot" | "none";
  /** Why something was not sent (the file, the buttons, the rate limit). */
  readonly note: string | null;
}

export interface ConnectorNotifyServiceShape {
  readonly resolveChats: (input: {
    readonly threadId: ThreadId | null;
    readonly projectId: ProjectId | null;
    readonly includeAssistantFallback: boolean;
    /**
     * Also resolve Slack chats (bound ones, and the owner's DMs in the
     * assistant fallback). Off for the events forwarder, on for `notify`.
     */
    readonly includeSlack?: boolean;
  }) => Effect.Effect<ReadonlyArray<ResolvedNotifyChat>>;
  readonly sendToChats: (
    chats: ReadonlyArray<ResolvedNotifyChat>,
    text: string,
    /** Slack: write as this assistant when several share Uno's app. */
    options?: { readonly asAssistant?: ProjectId | null },
  ) => Effect.Effect<ChannelNotifyResult>;
  /**
   * A chat writes to the person through their messenger: the chats bound to
   * it, else the person's own private chat (their bot or Uno's), else Uno's
   * service bot (text only). Never fails.
   */
  readonly sendToPerson: (input: PersonMessageInput) => Effect.Effect<PersonMessageResult>;
  /** An approval was answered somewhere: its Telegram buttons go. */
  readonly retireButtons: (requestId: string) => Effect.Effect<void>;
  /** The HTTP endpoint's semantics: resolve (with assistant fallback) and send. */
  readonly notify: (input: ChannelNotifyInput) => Effect.Effect<ChannelNotifyResult>;
}

export class ConnectorNotifyService extends Context.Service<
  ConnectorNotifyService,
  ConnectorNotifyServiceShape
>()("t3/manager/Services/ConnectorNotifyService") {}
