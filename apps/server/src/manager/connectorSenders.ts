/**
 * Who may drive the assistant through a chat connector.
 *
 * An allowlisted chat is not the same as an allowlisted person: in a group
 * or shared channel every member can write, and the assistant's chat
 * threads run with full access to the computer. So each inbound message is
 * classified by its SENDER:
 *
 * - `owner`   — the owner's own account: full behaviour (commands, the
 *               routed runtime mode).
 * - `member`  — someone else in a group, heard only when the owner opted in
 *               (`groupMembers: "anyone-with-approval"`): no chat commands,
 *               turns always run approval-required.
 * - `ignore`  — bots, unknown senders, everyone else.
 *
 * Telegram: a private chat's id is its user's id, so every allowlisted
 * private chat is an owner (this also covers chats linked before owners were
 * recorded). Slack: an allowlisted DM belongs to exactly one person; the
 * app's installer and DM senders are recorded as owners.
 *
 * Pure: the connectors feed it what they read and act on the result.
 *
 * @module manager/connectorSenders
 */
import type { ManagerConnectorGroupMembersPolicy, RuntimeMode } from "@t3tools/contracts";

import { isPrivateTelegramChatId } from "./connectorBindings.ts";

export type ConnectorSenderRole = "owner" | "member" | "ignore";

const policyOrDefault = (
  policy: ManagerConnectorGroupMembersPolicy | undefined,
): ManagerConnectorGroupMembersPolicy => policy ?? "owners";

/** Owner user ids of a Telegram connector: recorded ones + allowlisted private chats. */
export const telegramOwnerUserIds = (input: {
  readonly allowedChatIds: ReadonlyArray<string>;
  readonly ownerUserIds?: ReadonlyArray<string> | undefined;
}): ReadonlySet<string> => {
  const owners = new Set<string>();
  for (const id of input.ownerUserIds ?? []) owners.add(id.trim());
  for (const chatId of input.allowedChatIds) {
    if (isPrivateTelegramChatId(chatId)) owners.add(chatId.trim());
  }
  return owners;
};

export const classifyTelegramSender = (input: {
  readonly chat: { readonly id?: number | string; readonly type?: string } | undefined;
  readonly from: { readonly id?: number | string; readonly is_bot?: boolean } | undefined;
  readonly allowedChatIds: ReadonlyArray<string>;
  readonly ownerUserIds?: ReadonlyArray<string> | undefined;
  readonly groupMembers?: ManagerConnectorGroupMembersPolicy | undefined;
}): ConnectorSenderRole => {
  const from = input.from;
  if (from === undefined || from.id === undefined || from.is_bot === true) return "ignore";
  const senderId = String(from.id);
  const chatId = input.chat?.id === undefined ? null : String(input.chat.id);
  if (chatId === null) return "ignore";
  const isPrivate =
    input.chat?.type !== undefined
      ? input.chat.type === "private"
      : isPrivateTelegramChatId(chatId);
  if (isPrivate) {
    // A private chat is the conversation with exactly this user.
    return senderId === chatId ? "owner" : "ignore";
  }
  if (telegramOwnerUserIds(input).has(senderId)) return "owner";
  return policyOrDefault(input.groupMembers) === "anyone-with-approval" ? "member" : "ignore";
};

export const classifySlackSender = (input: {
  readonly userId: string | undefined;
  readonly senderIsBot: boolean;
  /** `channel_type === "im"`: a 1:1 DM with the bot. Group DMs (`mpim`) are groups. */
  readonly isDirectMessage: boolean;
  readonly ownerUserIds?: ReadonlyArray<string> | undefined;
  readonly groupMembers?: ManagerConnectorGroupMembersPolicy | undefined;
}): ConnectorSenderRole => {
  if (input.senderIsBot || input.userId === undefined || input.userId.trim().length === 0) {
    return "ignore";
  }
  if (input.isDirectMessage) return "owner";
  if ((input.ownerUserIds ?? []).includes(input.userId)) return "owner";
  return policyOrDefault(input.groupMembers) === "anyone-with-approval" ? "member" : "ignore";
};

/**
 * The runtime mode a turn runs in: the routed mode for the owner, always
 * approval-required for anyone else. Never widens.
 */
export const runtimeModeForSender = (
  role: Exclude<ConnectorSenderRole, "ignore">,
  routedMode: RuntimeMode,
): RuntimeMode => (role === "owner" ? routedMode : "approval-required");

/** `ownerUserIds` with `userId` added (same array when already present). */
export const withOwnerUserId = (
  ownerUserIds: ReadonlyArray<string> | undefined,
  userId: string,
): ReadonlyArray<string> => {
  const current = ownerUserIds ?? [];
  return current.includes(userId) ? current : [...current, userId];
};
