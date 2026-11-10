import type { ManagerTelegramConnectorConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { classifyTelegramSender } from "./connectorSenders.ts";
import {
  decodeGroupDirectory,
  EMPTY_GROUP_DIRECTORY,
  forgetSeenGroup,
  MAX_SEEN_PEOPLE,
  pruneTelegramGroupAccess,
  recordGroupSender,
  resolveGroupPeople,
  telegramGroupAccess,
  telegramGroupsView,
  withTelegramGroupAccess,
} from "./telegramGroups.ts";

const FAMILY = "-100111";
const WORK = "-100222";
const OWNER = "42";

const config = (extra: Partial<ManagerTelegramConnectorConfig> = {}) =>
  ({
    botToken: "1:abc",
    allowedChatIds: [OWNER, FAMILY, WORK],
    enabled: true,
    ownerUserIds: [OWNER],
    ...extra,
  }) satisfies ManagerTelegramConnectorConfig;

const roleIn = (cfg: ManagerTelegramConnectorConfig, chatId: string, senderId: number) =>
  classifyTelegramSender({
    chat: { id: Number(chatId), type: "supergroup" },
    from: { id: senderId },
    allowedChatIds: cfg.allowedChatIds,
    ownerUserIds: cfg.ownerUserIds,
    groupAccess: telegramGroupAccess(cfg, chatId),
  });

describe("who is heard in a group", () => {
  it("only the owner by default", () => {
    const cfg = config();
    expect(telegramGroupAccess(cfg, FAMILY)).toEqual({ members: "owners", userIds: [] });
    expect(roleIn(cfg, FAMILY, 42)).toBe("owner");
    expect(roleIn(cfg, FAMILY, 7)).toBe("ignore");
  });

  it("the people picked in THAT group, and nobody else", () => {
    const cfg = config({ groups: { [FAMILY]: { members: "selected", userIds: ["7"] } } });
    expect(roleIn(cfg, FAMILY, 7)).toBe("member");
    expect(roleIn(cfg, FAMILY, 8)).toBe("ignore");
    // Picked in Family is not picked at work.
    expect(roleIn(cfg, WORK, 7)).toBe("ignore");
    expect(roleIn(cfg, FAMILY, 42)).toBe("owner");
  });

  it("everyone in one group leaves the other groups closed", () => {
    const cfg = config({ groups: { [WORK]: { members: "anyone", userIds: [] } } });
    expect(roleIn(cfg, WORK, 7)).toBe("member");
    expect(roleIn(cfg, FAMILY, 7)).toBe("ignore");
  });

  it("a group's own choice wins over the older connector-wide one", () => {
    const cfg = config({
      groupMembers: "anyone-with-approval",
      groups: { [FAMILY]: { members: "owners", userIds: [] } },
    });
    expect(roleIn(cfg, FAMILY, 7)).toBe("ignore");
    // No entry of its own: the connector-wide choice still stands.
    expect(roleIn(cfg, WORK, 7)).toBe("member");
  });

  it("a picked person stays ignored once the group is back on only-me", () => {
    const cfg = config({ groups: { [FAMILY]: { members: "owners", userIds: ["7"] } } });
    expect(roleIn(cfg, FAMILY, 7)).toBe("ignore");
  });

  it("never hears bots, whatever the choice", () => {
    const cfg = config({ groups: { [FAMILY]: { members: "anyone", userIds: [] } } });
    expect(
      classifyTelegramSender({
        chat: { id: Number(FAMILY), type: "supergroup" },
        from: { id: 9, is_bot: true },
        allowedChatIds: cfg.allowedChatIds,
        ownerUserIds: cfg.ownerUserIds,
        groupAccess: telegramGroupAccess(cfg, FAMILY),
      }),
    ).toBe("ignore");
  });
});

describe("changing a group's choice", () => {
  it("sets the choice and keeps the rest of the config", () => {
    const change = withTelegramGroupAccess(config(), {
      chatId: FAMILY,
      members: "selected",
      userIds: ["7", "7", " 8 "],
    });
    expect(change.ok).toBe(true);
    if (!change.ok) return;
    expect(change.config.groups).toEqual({
      [FAMILY]: { members: "selected", userIds: ["7", "8"] },
    });
    expect(change.config.allowedChatIds).toEqual([OWNER, FAMILY, WORK]);
    expect(change.config.ownerUserIds).toEqual([OWNER]);
  });

  it("adds a group that is not in the bot's chats yet", () => {
    const change = withTelegramGroupAccess(config(), { chatId: "-100333", members: "owners" });
    expect(change.ok && change.config.allowedChatIds).toEqual([OWNER, FAMILY, WORK, "-100333"]);
  });

  it("keeps the picked people when only the mode changes", () => {
    const start = config({ groups: { [FAMILY]: { members: "selected", userIds: ["7"] } } });
    const change = withTelegramGroupAccess(start, { chatId: FAMILY, members: "owners" });
    expect(change.ok && change.config.groups?.[FAMILY]).toEqual({
      members: "owners",
      userIds: ["7"],
    });
  });

  it("drops the owner and junk from the picked list", () => {
    const change = withTelegramGroupAccess(config(), {
      chatId: FAMILY,
      members: "selected",
      userIds: [OWNER, "abc", "-5", "7"],
    });
    expect(change.ok && change.config.groups?.[FAMILY]?.userIds).toEqual(["7"]);
  });

  it("refuses a private chat", () => {
    const change = withTelegramGroupAccess(config(), { chatId: OWNER, members: "anyone" });
    expect(change.ok).toBe(false);
  });

  it("a removed group takes its choice with it", () => {
    const groups = {
      [FAMILY]: { members: "anyone" as const, userIds: [] },
      [WORK]: { members: "selected" as const, userIds: ["7"] },
    };
    expect(pruneTelegramGroupAccess(groups, [OWNER, WORK])).toEqual({ [WORK]: groups[WORK] });
    expect(pruneTelegramGroupAccess(groups, [OWNER])).toBeUndefined();
    expect(pruneTelegramGroupAccess(undefined, [OWNER])).toBeUndefined();
  });
});

describe("people seen in groups", () => {
  const now = "2026-11-10T10:00:00.000Z";
  const seen = (
    directory = EMPTY_GROUP_DIRECTORY,
    from: Record<string, unknown> = { id: 7, first_name: "Anna", username: "anna_k" },
    at = now,
    chatId = FAMILY,
  ) =>
    recordGroupSender(directory, {
      connectorProjectId: "assistant-home",
      chatId,
      title: "Family",
      from,
      nowIso: at,
    });

  it("remembers who wrote, with the group's name", () => {
    const directory = seen();
    expect(directory.connectors["assistant-home"]).toEqual([
      {
        chatId: FAMILY,
        title: "Family",
        seenAt: now,
        people: [{ id: "7", name: "Anna", username: "anna_k", seenAt: now }],
      },
    ]);
  });

  it("writes nothing new for the same person a minute later", () => {
    const first = seen();
    expect(seen(first, undefined, "2026-11-10T10:01:00.000Z")).toBe(first);
  });

  it("picks up a changed name", () => {
    const first = seen();
    const next = seen(first, { id: 7, first_name: "Anna", last_name: "K" });
    expect(next.connectors["assistant-home"]?.[0]?.people).toEqual([
      { id: "7", name: "Anna K", username: null, seenAt: now },
    ]);
  });

  it("never remembers bots or private chats", () => {
    expect(seen(EMPTY_GROUP_DIRECTORY, { id: 9, is_bot: true, first_name: "Bot" })).toBe(
      EMPTY_GROUP_DIRECTORY,
    );
    expect(seen(EMPTY_GROUP_DIRECTORY, undefined, now, "42")).toBe(EMPTY_GROUP_DIRECTORY);
  });

  it("keeps the newest people when a group is crowded", () => {
    let directory = EMPTY_GROUP_DIRECTORY;
    for (let index = 1; index <= MAX_SEEN_PEOPLE + 5; index += 1) {
      directory = seen(
        directory,
        { id: index, first_name: `P${index}` },
        new Date(Date.parse(now) + index * 1000).toISOString(),
      );
    }
    const people = directory.connectors["assistant-home"]?.[0]?.people ?? [];
    expect(people).toHaveLength(MAX_SEEN_PEOPLE);
    expect(people[0]?.id).toBe(String(MAX_SEEN_PEOPLE + 5));
    expect(people.some((person) => person.id === "1")).toBe(false);
  });

  it("survives a round trip through the file and drops junk", () => {
    const directory = seen();
    expect(decodeGroupDirectory(JSON.parse(JSON.stringify(directory)))).toEqual(directory);
    expect(decodeGroupDirectory({ connectors: { a: [{ chatId: "42" }, 5, null] } })).toEqual({
      connectors: { a: [] },
    });
    expect(decodeGroupDirectory("nope")).toEqual(EMPTY_GROUP_DIRECTORY);
  });

  it("forgets a group", () => {
    const directory = seen();
    expect(
      forgetSeenGroup(directory, "assistant-home", FAMILY).connectors["assistant-home"],
    ).toEqual([]);
    expect(forgetSeenGroup(directory, "assistant-home", WORK)).toBe(directory);
  });
});

describe("what the settings page sees", () => {
  const now = "2026-11-10T10:00:00.000Z";
  const directory = [
    { id: 42, first_name: "Misha" },
    { id: 7, first_name: "Anna", username: "anna_k" },
    { id: 8, first_name: "Dima" },
  ].reduce(
    (state, from) =>
      recordGroupSender(state, {
        connectorProjectId: "p",
        chatId: FAMILY,
        title: "Family",
        from,
        nowIso: now,
      }),
    recordGroupSender(EMPTY_GROUP_DIRECTORY, {
      connectorProjectId: "p",
      chatId: "-100999",
      title: "Book club",
      from: { id: 42, first_name: "Misha" },
      nowIso: now,
    }),
  );
  const view = (cfg: ManagerTelegramConnectorConfig, supported = true) =>
    telegramGroupsView({
      config: cfg,
      seen: directory.connectors["p"] ?? [],
      botUsername: "my_bot",
      supported,
    });

  it("lists the groups with their choice and people; the owner first", () => {
    const result = view(config({ groups: { [FAMILY]: { members: "selected", userIds: ["8"] } } }));
    const family = result.groups.find((group) => group.chatId === FAMILY);
    expect(family?.title).toBe("Family");
    expect(family?.members).toBe("selected");
    expect(family?.people.map((p) => [p.name, p.owner, p.selected, p.allowed])).toEqual([
      ["Misha", true, false, true],
      ["Dima", false, true, true],
      ["Anna", false, false, false],
    ]);
    // A group nobody wrote in yet: no name, default choice.
    expect(result.groups.find((group) => group.chatId === WORK)).toEqual({
      chatId: WORK,
      title: null,
      members: "owners",
      people: [],
    });
  });

  it("offers the group the owner called the bot in", () => {
    expect(view(config()).pending).toEqual([{ chatId: "-100999", title: "Book club" }]);
  });

  it("shows a person picked by id before the bot saw them", () => {
    const result = view(config({ groups: { [WORK]: { members: "selected", userIds: ["77"] } } }));
    expect(result.groups.find((group) => group.chatId === WORK)?.people).toEqual([
      { id: "77", name: "77", username: null, owner: false, selected: true, allowed: true },
    ]);
  });

  it("everyone: all seen people are heard", () => {
    const result = view(config({ groups: { [FAMILY]: { members: "anyone", userIds: [] } } }));
    expect(result.groups[0]?.people.every((person) => person.allowed)).toBe(true);
  });

  it("Uno's shared bot: no groups offered", () => {
    expect(view(config(), false)).toMatchObject({ supported: false, pending: [] });
  });
});

describe("people named in a tool call", () => {
  const people = [
    { id: "7", name: "Anna K", username: "anna_k" },
    { id: "8", name: "Dima", username: null },
    { id: "9", name: "Anna Petrova", username: null },
  ];

  it("takes ids, @usernames and names", () => {
    expect(resolveGroupPeople(people, ["123456", "@Anna_K", "dima"])).toEqual({
      userIds: ["123456", "7", "8"],
      unknown: [],
    });
  });

  it("a first name only when it is one person", () => {
    expect(resolveGroupPeople(people, ["Anna"])).toEqual({ userIds: [], unknown: ["Anna"] });
    expect(resolveGroupPeople(people, ["Anna Petrova"]).userIds).toEqual(["9"]);
  });

  it("says who it does not know", () => {
    expect(resolveGroupPeople(people, ["Zed"]).unknown).toEqual(["Zed"]);
  });
});
