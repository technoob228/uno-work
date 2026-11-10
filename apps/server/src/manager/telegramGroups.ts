/**
 * Who is heard in each Telegram group (10.11).
 *
 * A group the bot answers in has one choice: only the owner (`owners`), the
 * people the owner picked (`selected`), or every member (`anyone`). The
 * choice is per group (`config.groups[chatId]`) and wins over the older
 * connector-wide `groupMembers`. Whoever is let in is a `member`
 * (`connectorSenders.ts`): a thread apart from the owner's, always
 * approval-required, no chat commands.
 *
 * To pick people with a button the settings page needs names, and a bot
 * cannot list a group's members — so the connector keeps a small directory of
 * who it has seen writing in each group (`telegram-groups.json` in the state
 * dir). It also remembers groups the OWNER wrote to the bot in that are not
 * added yet, so adding a group is a button, not a chat id typed by hand.
 * Strangers' groups are never remembered.
 *
 * Pure: the connector feeds it what it reads and stores the result.
 *
 * @module manager/telegramGroups
 */
import type {
  ManagerTelegramConnectorConfig,
  ManagerTelegramGroupAccess,
  ManagerTelegramGroupMembers,
  ManagerTelegramGroupPerson,
  ManagerTelegramGroupsResult,
  ManagerTelegramGroupView,
} from "@t3tools/contracts";

import { telegramOwnerUserIds } from "./connectorSenders.ts";

export const TELEGRAM_GROUPS_FILE = "telegram-groups.json";
/** Groups remembered per bot; the oldest seen go first. */
export const MAX_SEEN_GROUPS = 60;
/** People remembered per group; the oldest seen go first. */
export const MAX_SEEN_PEOPLE = 80;
/** A known person's `seenAt` is rewritten at most this often (fewer disk writes). */
export const SEEN_REFRESH_MS = 60 * 60_000;
/** People one group may list as `selected`. */
export const MAX_SELECTED_PEOPLE = 200;

/** A Telegram group / supergroup / channel id: a negative integer. */
export const isTelegramGroupChatId = (chatId: string): boolean => /^-\d+$/.test(chatId.trim());

type AccessConfig = Pick<ManagerTelegramConnectorConfig, "groups" | "groupMembers">;

/** The choice a group runs under: its own, else the connector-wide one. */
export const telegramGroupAccess = (
  config: AccessConfig,
  chatId: string,
): ManagerTelegramGroupAccess => {
  const own = config.groups?.[chatId];
  if (own !== undefined) return own;
  return {
    members: config.groupMembers === "anyone-with-approval" ? "anyone" : "owners",
    userIds: [],
  };
};

/** Whether a non-owner sender is heard under `access`. */
export const groupLetsIn = (access: ManagerTelegramGroupAccess, senderId: string): boolean =>
  access.members === "anyone" ||
  (access.members === "selected" && access.userIds.includes(senderId));

// ---------------------------------------------------------------------------
// The directory of seen groups and people
// ---------------------------------------------------------------------------

export interface SeenPerson {
  readonly id: string;
  readonly name: string;
  readonly username: string | null;
  readonly seenAt: string;
}

export interface SeenGroup {
  readonly chatId: string;
  readonly title: string | null;
  readonly people: ReadonlyArray<SeenPerson>;
  readonly seenAt: string;
}

/** Seen groups by the connector's (assistant) project id. */
export interface TelegramGroupDirectory {
  readonly connectors: Readonly<Record<string, ReadonlyArray<SeenGroup>>>;
}

export const EMPTY_GROUP_DIRECTORY: TelegramGroupDirectory = { connectors: {} };

const cleanText = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

export const telegramPersonName = (from: {
  readonly id?: number | string;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
}): string => {
  const full = cleanText([from.first_name, from.last_name].filter(Boolean).join(" "), 64);
  if (full.length > 0) return full;
  const username = cleanText(from.username, 64);
  return username.length > 0 ? `@${username}` : String(from.id ?? "");
};

const newestFirst = <T extends { readonly seenAt: string }>(items: ReadonlyArray<T>) =>
  items.toSorted((a, b) => (a.seenAt < b.seenAt ? 1 : a.seenAt > b.seenAt ? -1 : 0));

/**
 * Remember that `from` wrote in group `chatId` of this bot. Returns the SAME
 * directory when nothing worth a disk write changed.
 */
export const recordGroupSender = (
  directory: TelegramGroupDirectory,
  input: {
    readonly connectorProjectId: string;
    readonly chatId: string;
    readonly title: string | null | undefined;
    readonly from: {
      readonly id?: number | string;
      readonly is_bot?: boolean;
      readonly first_name?: string;
      readonly last_name?: string;
      readonly username?: string;
    };
    readonly nowIso: string;
  },
): TelegramGroupDirectory => {
  const { from } = input;
  if (from.id === undefined || from.is_bot === true) return directory;
  if (!isTelegramGroupChatId(input.chatId)) return directory;
  const personId = String(from.id);
  const name = telegramPersonName(from);
  const username = cleanText(from.username, 64) || null;
  const title = cleanText(input.title, 120) || null;

  const groups = directory.connectors[input.connectorProjectId] ?? [];
  const group = groups.find((entry) => entry.chatId === input.chatId);
  const person = group?.people.find((entry) => entry.id === personId);
  const stale = (seenAt: string) =>
    Date.parse(input.nowIso) - Date.parse(seenAt) > SEEN_REFRESH_MS ||
    Number.isNaN(Date.parse(seenAt));
  if (
    group !== undefined &&
    person !== undefined &&
    person.name === name &&
    person.username === username &&
    (title === null || group.title === title) &&
    !stale(person.seenAt)
  ) {
    return directory;
  }

  const nextPerson: SeenPerson = { id: personId, name, username, seenAt: input.nowIso };
  const people = newestFirst([
    nextPerson,
    ...(group?.people ?? []).filter((entry) => entry.id !== personId),
  ]).slice(0, MAX_SEEN_PEOPLE);
  const nextGroup: SeenGroup = {
    chatId: input.chatId,
    title: title ?? group?.title ?? null,
    people,
    seenAt: input.nowIso,
  };
  const nextGroups = newestFirst([
    nextGroup,
    ...groups.filter((entry) => entry.chatId !== input.chatId),
  ]).slice(0, MAX_SEEN_GROUPS);
  return {
    connectors: { ...directory.connectors, [input.connectorProjectId]: nextGroups },
  };
};

/** Drop a group from the directory (the owner dismissed or removed it). */
export const forgetSeenGroup = (
  directory: TelegramGroupDirectory,
  connectorProjectId: string,
  chatId: string,
): TelegramGroupDirectory => {
  const groups = directory.connectors[connectorProjectId];
  if (groups === undefined || !groups.some((entry) => entry.chatId === chatId)) return directory;
  return {
    connectors: {
      ...directory.connectors,
      [connectorProjectId]: groups.filter((entry) => entry.chatId !== chatId),
    },
  };
};

/** Lenient decode of the file: anything malformed is dropped, never thrown. */
export const decodeGroupDirectory = (raw: unknown): TelegramGroupDirectory => {
  if (typeof raw !== "object" || raw === null) return EMPTY_GROUP_DIRECTORY;
  const source = (raw as { connectors?: unknown }).connectors;
  if (typeof source !== "object" || source === null) return EMPTY_GROUP_DIRECTORY;
  const connectors: Record<string, ReadonlyArray<SeenGroup>> = {};
  for (const [projectId, value] of Object.entries(source as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const groups: Array<SeenGroup> = [];
    for (const entry of value) {
      if (typeof entry !== "object" || entry === null) continue;
      const item = entry as Record<string, unknown>;
      if (typeof item.chatId !== "string" || !isTelegramGroupChatId(item.chatId)) continue;
      const people: Array<SeenPerson> = [];
      for (const rawPerson of Array.isArray(item.people) ? item.people : []) {
        if (typeof rawPerson !== "object" || rawPerson === null) continue;
        const one = rawPerson as Record<string, unknown>;
        if (typeof one.id !== "string" || one.id.trim().length === 0) continue;
        people.push({
          id: one.id.trim(),
          name: cleanText(one.name, 64) || one.id.trim(),
          username: cleanText(one.username, 64) || null,
          seenAt: typeof one.seenAt === "string" ? one.seenAt : "",
        });
      }
      groups.push({
        chatId: item.chatId.trim(),
        title: cleanText(item.title, 120) || null,
        people: people.slice(0, MAX_SEEN_PEOPLE),
        seenAt: typeof item.seenAt === "string" ? item.seenAt : "",
      });
    }
    connectors[projectId] = groups.slice(0, MAX_SEEN_GROUPS);
  }
  return { connectors };
};

// ---------------------------------------------------------------------------
// What the settings page and `assistant_groups` see
// ---------------------------------------------------------------------------

export const telegramGroupsView = (input: {
  readonly config: Pick<
    ManagerTelegramConnectorConfig,
    "allowedChatIds" | "ownerUserIds" | "groups" | "groupMembers"
  >;
  readonly seen: ReadonlyArray<SeenGroup>;
  readonly botUsername: string | null;
  readonly supported: boolean;
}): ManagerTelegramGroupsResult => {
  const { config } = input;
  const owners = telegramOwnerUserIds(config);
  const seenById = new Map(input.seen.map((group) => [group.chatId, group]));
  const groups: Array<ManagerTelegramGroupView> = config.allowedChatIds
    .filter(isTelegramGroupChatId)
    .map((chatId) => {
      const access = telegramGroupAccess(config, chatId);
      const seen = seenById.get(chatId);
      const known = new Map<string, ManagerTelegramGroupPerson>();
      for (const person of seen?.people ?? []) {
        const owner = owners.has(person.id);
        known.set(person.id, {
          id: person.id,
          name: person.name,
          username: person.username,
          owner,
          selected: !owner && access.userIds.includes(person.id),
          allowed: owner || groupLetsIn(access, person.id),
        });
      }
      // Picked by id (through the tool) before the bot ever saw them write.
      for (const userId of access.userIds) {
        if (known.has(userId)) continue;
        known.set(userId, {
          id: userId,
          name: userId,
          username: null,
          owner: owners.has(userId),
          selected: !owners.has(userId),
          allowed: owners.has(userId) || groupLetsIn(access, userId),
        });
      }
      const rank = (person: ManagerTelegramGroupPerson) =>
        person.owner ? 0 : access.userIds.includes(person.id) ? 1 : 2;
      const people = [...known.values()].toSorted((a, b) => rank(a) - rank(b));
      return { chatId, title: seen?.title ?? null, members: access.members, people };
    });
  const pending = input.supported
    ? input.seen
        .filter((group) => !config.allowedChatIds.includes(group.chatId))
        .map((group) => ({ chatId: group.chatId, title: group.title }))
    : [];
  return { supported: input.supported, botUsername: input.botUsername, groups, pending };
};

// ---------------------------------------------------------------------------
// Changing a group's choice
// ---------------------------------------------------------------------------

export type GroupAccessChange =
  | { readonly ok: true; readonly config: ManagerTelegramConnectorConfig }
  | { readonly ok: false; readonly error: string };

/**
 * `config` with group `chatId` set to `members` (+ `userIds` for `selected`).
 * A group that is not in the allowlist yet is added: the choice and "the bot
 * answers here" are one decision for the owner.
 */
export const withTelegramGroupAccess = (
  config: ManagerTelegramConnectorConfig,
  input: {
    readonly chatId: string;
    readonly members: ManagerTelegramGroupMembers;
    readonly userIds?: ReadonlyArray<string> | undefined;
  },
): GroupAccessChange => {
  const chatId = input.chatId.trim();
  if (!isTelegramGroupChatId(chatId)) {
    return { ok: false, error: "That is not a group: a group's chat id starts with a minus." };
  }
  const owners = telegramOwnerUserIds(config);
  const previous = config.groups?.[chatId];
  const cleaned = [
    ...new Set(
      (input.userIds ?? previous?.userIds ?? [])
        .map((id) => id.trim())
        .filter((id) => /^[1-9]\d*$/.test(id) && !owners.has(id)),
    ),
  ];
  if (cleaned.length > MAX_SELECTED_PEOPLE) {
    return { ok: false, error: `At most ${MAX_SELECTED_PEOPLE} people per group.` };
  }
  return {
    ok: true,
    config: {
      ...config,
      allowedChatIds: config.allowedChatIds.includes(chatId)
        ? config.allowedChatIds
        : [...config.allowedChatIds, chatId],
      groups: { ...config.groups, [chatId]: { members: input.members, userIds: cleaned } },
    },
  };
};

/** `groups` without the entries of chats that are no longer in the allowlist. */
export const pruneTelegramGroupAccess = (
  groups: ManagerTelegramConnectorConfig["groups"],
  allowedChatIds: ReadonlyArray<string>,
): ManagerTelegramConnectorConfig["groups"] => {
  if (groups === undefined) return undefined;
  const kept = Object.fromEntries(
    Object.entries(groups).filter(([chatId]) => allowedChatIds.includes(chatId)),
  );
  return Object.keys(kept).length === 0 ? undefined : kept;
};

/**
 * Resolve the people named in a tool call (`assistant_groups`) against the
 * group's seen people: a numeric id, an @username, or a name as shown.
 * Unknown names are returned so the caller can say who was not found.
 */
export const resolveGroupPeople = (
  people: ReadonlyArray<Pick<ManagerTelegramGroupPerson, "id" | "name" | "username">>,
  asked: ReadonlyArray<string>,
): { readonly userIds: ReadonlyArray<string>; readonly unknown: ReadonlyArray<string> } => {
  const userIds: Array<string> = [];
  const unknown: Array<string> = [];
  const fold = (value: string) => value.trim().replace(/^@/, "").toLowerCase();
  for (const raw of asked) {
    const wanted = raw.trim();
    if (wanted.length === 0) continue;
    if (/^[1-9]\d*$/.test(wanted)) {
      userIds.push(wanted);
      continue;
    }
    const key = fold(wanted);
    const byUsername = people.filter(
      (person) => person.username !== null && fold(person.username) === key,
    );
    const byName = people.filter((person) => fold(person.name) === key);
    const byFirstName = people.filter((person) => fold(person.name).split(" ")[0] === key);
    const match = [byUsername, byName, byFirstName].find((list) => list.length === 1);
    if (match === undefined) unknown.push(wanted);
    else userIds.push(match[0]!.id);
  }
  return { userIds: [...new Set(userIds)], unknown };
};
