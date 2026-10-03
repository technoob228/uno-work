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

import type { ResolvedNotifyChat } from "../connectorBindings.ts";

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
  /** The HTTP endpoint's semantics: resolve (with assistant fallback) and send. */
  readonly notify: (input: ChannelNotifyInput) => Effect.Effect<ChannelNotifyResult>;
}

export class ConnectorNotifyService extends Context.Service<
  ConnectorNotifyService,
  ConnectorNotifyServiceShape
>()("t3/manager/Services/ConnectorNotifyService") {}
