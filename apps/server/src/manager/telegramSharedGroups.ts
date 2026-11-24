/**
 * Telegram groups through Uno's assistant bot (@uno_work_bot, T57, 20.11).
 *
 * With the assistant's own bot the daemon sees every update of its groups and
 * decides alone (`telegramGroups.ts`). Through Uno's bot the console stands in
 * between (fishcode `internal/workrelay/groups.go`): it binds a group to this
 * computer when the owner adds the bot there or calls it, passes on only what
 * is addressed to the bot, and applies the owner's "who is heard" rule before
 * delivery. The daemon still checks the same rule again on every message.
 *
 * What the console says (`unoGroupsInfo`) and what the daemon keeps meet here:
 *
 * - `enabled` — groups work for this account (the console flag
 *   `WORK_TG_GROUPS_SHARED`). An older console answers 403 / unknown method:
 *   not supported, the page offers the own bot.
 * - The groups bound to this computer that the owner has not added yet show
 *   as waiting, with Telegram's title — the bot being added to a group
 *   (`my_chat_member`) never reaches the daemon.
 * - A group's rule here and at the console must match: the daemon is the
 *   source, `unoSetGroupAccess` pushes the difference. The rule includes
 *   `hearAll` (Misha 23.11): the owner opted in to get the group's messages
 *   that don't call the bot; the console drops them for every other group.
 * - `readsAll` — Telegram gives the bot whole groups (its Group Privacy is
 *   off). Until then only calls and replies reach it, `hearAll` or not.
 * - Decision 23.11: a group the console bound to this computer (the owner
 *   added the bot there) is added here at once with "only me", no button.
 *
 * Pure: the connector does the calls.
 *
 * @module manager/telegramSharedGroups
 */
import type {
  ManagerTelegramConnectorConfig,
  ManagerTelegramGroupAccess,
  ManagerTelegramGroupMembers,
  ManagerTelegramGroupsResult,
} from "@t3tools/contracts";

import { isTelegramGroupChatId, telegramGroupAccess } from "./telegramGroups.ts";

/** How long one `unoGroupsInfo` answer is trusted. */
export const SHARED_GROUPS_INFO_TTL_MS = 60_000;

export interface SharedGroupInfo {
  readonly chatId: string;
  readonly title: string | null;
  readonly members: ManagerTelegramGroupMembers;
  readonly userIds: ReadonlyArray<string>;
  readonly hearAll: boolean;
  /** This computer answers people without Uno there (the oldest binding). */
  readonly host: boolean;
  /** Uno accounts bound to the group, this one included. */
  readonly accounts: number;
}

export interface SharedGroupsInfo {
  readonly enabled: boolean;
  readonly botUsername: string | null;
  /** Null: the console didn't say (older console, or getMe failed). */
  readonly readsAll: boolean | null;
  readonly groups: ReadonlyArray<SharedGroupInfo>;
}

const asMembers = (value: unknown): ManagerTelegramGroupMembers =>
  value === "selected" || value === "anyone" ? value : "owners";

/**
 * The `result` of `unoGroupsInfo`, leniently. Null: not an answer of a
 * console that knows groups (treated as "not supported").
 */
export const decodeSharedGroupsInfo = (result: unknown): SharedGroupsInfo | null => {
  if (typeof result !== "object" || result === null) return null;
  const raw = result as Record<string, unknown>;
  if (typeof raw.enabled !== "boolean") return null;
  const groups: Array<SharedGroupInfo> = [];
  for (const entry of Array.isArray(raw.groups) ? raw.groups : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const chatId = typeof item.chat_id === "string" ? item.chat_id.trim() : String(item.chat_id);
    if (!isTelegramGroupChatId(chatId)) continue;
    const title =
      typeof item.title === "string" ? item.title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    groups.push({
      chatId,
      title: title.length > 0 ? title : null,
      members: asMembers(item.members),
      userIds: (Array.isArray(item.user_ids) ? item.user_ids : [])
        .map((id) => String(id).trim())
        .filter((id) => /^[1-9]\d*$/.test(id)),
      hearAll: item.hear_all === true,
      host: item.host === true,
      accounts: typeof item.accounts === "number" ? item.accounts : 1,
    });
  }
  return {
    enabled: raw.enabled,
    botUsername:
      typeof raw.bot_username === "string" && raw.bot_username.length > 0 ? raw.bot_username : null,
    readsAll: typeof raw.reads_all === "boolean" ? raw.reads_all : null,
    groups: raw.enabled ? groups : [],
  };
};

/**
 * The settings view with what only the console knows: groups bound to this
 * computer that are not added yet join `pending`, and titles the daemon has
 * not seen yet come from Telegram via the console.
 */
export const withSharedGroups = (
  view: ManagerTelegramGroupsResult,
  info: SharedGroupsInfo,
): ManagerTelegramGroupsResult => {
  const titles = new Map(info.groups.map((group) => [group.chatId, group.title]));
  const added = new Set(view.groups.map((group) => group.chatId));
  const pendingIds = new Set(view.pending.map((group) => group.chatId));
  const pending = [
    ...view.pending.map((group) => ({
      chatId: group.chatId,
      title: group.title ?? titles.get(group.chatId) ?? null,
    })),
    ...info.groups
      .filter((group) => !added.has(group.chatId) && !pendingIds.has(group.chatId))
      .map((group) => ({ chatId: group.chatId, title: group.title })),
  ];
  return {
    ...view,
    bot: "shared",
    ...(info.readsAll === null ? {} : { readsAll: info.readsAll }),
    botUsername: view.botUsername ?? info.botUsername,
    groups: view.groups.map((group) => ({
      ...group,
      title: group.title ?? titles.get(group.chatId) ?? null,
    })),
    pending,
  };
};

const sameAccess = (
  local: ManagerTelegramGroupAccess,
  remote: Pick<SharedGroupInfo, "members" | "userIds" | "hearAll">,
): boolean => {
  if (local.members !== remote.members) return false;
  if ((local.hearAll === true) !== remote.hearAll) return false;
  if (local.members !== "selected") return true;
  const wanted = new Set(local.userIds);
  return (
    wanted.size === new Set(remote.userIds).size && remote.userIds.every((id) => wanted.has(id))
  );
};

export interface SharedGroupAccessPush {
  readonly chatId: string;
  readonly members: ManagerTelegramGroupMembers;
  readonly userIds: ReadonlyArray<string>;
  readonly hearAll: boolean;
}

/**
 * Groups the owner added whose rule at the console differs from the one
 * here. Groups the console has no binding for are left out: nothing can be
 * delivered from them, and the binding starts as "only the owner" — the next
 * sync after the owner calls the bot there sets the rule.
 */
export const sharedGroupAccessPushes = (
  config: Pick<ManagerTelegramConnectorConfig, "allowedChatIds" | "groups" | "groupMembers">,
  info: SharedGroupsInfo,
): ReadonlyArray<SharedGroupAccessPush> => {
  if (!info.enabled) return [];
  const remote = new Map(info.groups.map((group) => [group.chatId, group]));
  const pushes: Array<SharedGroupAccessPush> = [];
  for (const chatId of config.allowedChatIds) {
    if (!isTelegramGroupChatId(chatId)) continue;
    const bound = remote.get(chatId);
    if (bound === undefined) continue;
    const local = telegramGroupAccess(config, chatId);
    if (sameAccess(local, bound)) continue;
    pushes.push({
      chatId,
      members: local.members,
      userIds: local.members === "selected" ? local.userIds : [],
      hearAll: local.hearAll === true,
    });
  }
  return pushes;
};

/** The body of `unoSetGroupAccess` for one push. */
export const sharedGroupAccessBody = (push: SharedGroupAccessPush): Record<string, unknown> => ({
  chat_id: push.chatId,
  members: push.members,
  user_ids: push.userIds,
  hear_all: push.hearAll,
});

/**
 * Groups the console bound to this computer that aren't added here yet: the
 * owner added the bot there (or called it). Decision 23.11: they are added at
 * once with "only me" — the owner is answered without pressing Add.
 */
export const sharedGroupsToAdd = (
  config: Pick<ManagerTelegramConnectorConfig, "allowedChatIds">,
  info: SharedGroupsInfo,
): ReadonlyArray<string> =>
  info.enabled
    ? info.groups
        .map((group) => group.chatId)
        .filter((chatId) => !config.allowedChatIds.includes(chatId))
    : [];
