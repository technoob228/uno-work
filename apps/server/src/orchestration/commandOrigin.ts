/**
 * Constructors for `OrchestrationCommandOrigin`.
 *
 * Every dispatch site that is not a human acting through the UI must stamp an
 * origin. The invariant the audit trail depends on is the negative one: an
 * event with no `metadata.origin` was caused by a person on this machine. That
 * only holds if connectors, the assistant bootstrapper, schedulers and peers
 * all go through here, so the helpers live in one module rather than being
 * spelled out inline at each call site.
 */

import type {
  OrchestrationAssistantCommandOrigin,
  OrchestrationCommandOrigin,
  OrchestrationCommandOriginConnectorKind,
  OrchestrationConnectorCommandOrigin,
  OrchestrationSystemCommandOrigin,
  ThreadStartedBy,
} from "@t3tools/contracts";

export const connectorCommandOrigin = (
  connector: OrchestrationCommandOriginConnectorKind,
  externalActorId?: string | null,
): OrchestrationConnectorCommandOrigin => {
  const trimmed = externalActorId?.trim() ?? "";
  return {
    kind: "connector",
    connector,
    ...(trimmed.length > 0 ? { externalActorId: trimmed } : {}),
  };
};

export const telegramCommandOrigin = (
  chatId?: string | null,
): OrchestrationConnectorCommandOrigin => connectorCommandOrigin("telegram", chatId);

export const slackCommandOrigin = (
  channelId?: string | null,
): OrchestrationConnectorCommandOrigin => connectorCommandOrigin("slack", channelId);

export const assistantCommandOrigin = (input: {
  readonly assistantKey: string;
  readonly tokenId?: string | null;
}): OrchestrationAssistantCommandOrigin => {
  const tokenId = input.tokenId?.trim() ?? "";
  return {
    kind: "assistant",
    assistantKey: input.assistantKey,
    ...(tokenId.length > 0 ? { tokenId } : {}),
  };
};

export const systemCommandOrigin = (
  component: string,
  reason?: string | null,
): OrchestrationSystemCommandOrigin => {
  const trimmedReason = reason?.trim() ?? "";
  return {
    kind: "system",
    component,
    ...(trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
  };
};

/** The person did it: here (no origin) or through Telegram / Slack. */
export const isPersonOrigin = (origin: OrchestrationCommandOrigin | undefined): boolean =>
  origin === undefined || origin.kind === "connector";

/**
 * Who started a chat, from the origin of the command that created it (see
 * ThreadStartedBy). Migration 051 backfills with the same table.
 */
export const startedByFromOrigin = (
  origin: OrchestrationCommandOrigin | undefined,
): ThreadStartedBy | null => {
  switch (origin?.kind) {
    case undefined:
    case "connector":
    case "peer":
      return null;
    case "agent":
      return "agent";
    case "manager":
    case "assistant":
      return "assistant";
    case "app":
    case "plugin":
      return "app";
    case "system":
      // The daemon opens the person's first chat for them.
      return null;
  }
};
