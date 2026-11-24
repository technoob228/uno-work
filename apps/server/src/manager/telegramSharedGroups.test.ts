import { describe, expect, it } from "vitest";

import {
  decodeSharedGroupsInfo,
  sharedGroupAccessBody,
  sharedGroupAccessPushes,
  sharedGroupsToAdd,
  withSharedGroups,
} from "./telegramSharedGroups.ts";

const FAMILY = "-100500";
const CLUB = "-100900";

describe("decodeSharedGroupsInfo", () => {
  it("reads the console's answer leniently", () => {
    expect(
      decodeSharedGroupsInfo({
        enabled: true,
        bot_username: "uno_work_bot",
        reads_all: false,
        groups: [
          {
            chat_id: FAMILY,
            title: "  Family\n chat ",
            members: "selected",
            user_ids: ["7", 8, "x", "-1"],
            hear_all: true,
            host: true,
            accounts: 2,
          },
          { chat_id: "42", title: "a private chat is not a group" },
          { chat_id: -100900, members: "everyone?" },
          null,
        ],
      }),
    ).toEqual({
      enabled: true,
      botUsername: "uno_work_bot",
      readsAll: false,
      groups: [
        {
          chatId: FAMILY,
          title: "Family chat",
          members: "selected",
          userIds: ["7", "8"],
          hearAll: true,
          host: true,
          accounts: 2,
        },
        {
          chatId: CLUB,
          title: null,
          members: "owners",
          userIds: [],
          hearAll: false,
          host: false,
          accounts: 1,
        },
      ],
    });
  });

  it("groups off: no groups, whatever came along", () => {
    expect(decodeSharedGroupsInfo({ enabled: false, groups: [{ chat_id: FAMILY }] })).toEqual({
      enabled: false,
      botUsername: null,
      readsAll: null,
      groups: [],
    });
  });

  it("not an answer of a console that knows groups", () => {
    expect(decodeSharedGroupsInfo(true)).toBeNull();
    expect(decodeSharedGroupsInfo(null)).toBeNull();
    expect(decodeSharedGroupsInfo({ groups: [] })).toBeNull();
  });
});

describe("withSharedGroups", () => {
  it("bound groups not added yet wait, titles come from the console", () => {
    const info = decodeSharedGroupsInfo({
      enabled: true,
      bot_username: "uno_work_bot",
      reads_all: true,
      groups: [
        { chat_id: FAMILY, title: "Family" },
        { chat_id: CLUB, title: "Book club" },
        { chat_id: "-100777", title: "Work" },
      ],
    })!;
    const view = withSharedGroups(
      {
        supported: true,
        botUsername: null,
        groups: [{ chatId: FAMILY, title: null, members: "owners", people: [] }],
        pending: [{ chatId: CLUB, title: null }],
      },
      info,
    );
    expect(view).toEqual({
      supported: true,
      bot: "shared",
      readsAll: true,
      botUsername: "uno_work_bot",
      groups: [{ chatId: FAMILY, title: "Family", members: "owners", people: [] }],
      pending: [
        { chatId: CLUB, title: "Book club" },
        { chatId: "-100777", title: "Work" },
      ],
    });
  });
});

describe("sharedGroupAccessPushes", () => {
  const info = decodeSharedGroupsInfo({
    enabled: true,
    groups: [
      { chat_id: FAMILY, members: "selected", user_ids: ["8", "7"] },
      { chat_id: CLUB, members: "owners" },
    ],
  })!;

  it("nothing when both sides agree (order of people does not matter)", () => {
    expect(
      sharedGroupAccessPushes(
        {
          allowedChatIds: ["777", FAMILY, CLUB],
          groups: {
            [FAMILY]: { members: "selected", userIds: ["7", "8"] },
            // People kept from an earlier "selected" do not count under "owners".
            [CLUB]: { members: "owners", userIds: ["9"] },
          },
        },
        info,
      ),
    ).toEqual([]);
  });

  it("the owner's rule wins; groups the console has not bound are left out", () => {
    const pushes = sharedGroupAccessPushes(
      {
        allowedChatIds: ["777", FAMILY, CLUB, "-100777"],
        groups: {
          [FAMILY]: { members: "selected", userIds: ["7"] },
          [CLUB]: { members: "anyone", userIds: ["9"] },
          "-100777": { members: "anyone", userIds: [] },
        },
      },
      info,
    );
    expect(pushes).toEqual([
      { chatId: FAMILY, members: "selected", userIds: ["7"], hearAll: false },
      { chatId: CLUB, members: "anyone", userIds: [], hearAll: false },
    ]);
    expect(sharedGroupAccessBody(pushes[0]!)).toEqual({
      chat_id: FAMILY,
      members: "selected",
      user_ids: ["7"],
      hear_all: false,
    });
  });

  it("a group removed here is not pushed (it is unlinked instead)", () => {
    expect(
      sharedGroupAccessPushes(
        { allowedChatIds: ["777"], groups: { [CLUB]: { members: "anyone", userIds: [] } } },
        info,
      ),
    ).toEqual([]);
  });

  it("the older connector-wide choice counts for groups without their own", () => {
    expect(
      sharedGroupAccessPushes(
        { allowedChatIds: [CLUB], groupMembers: "anyone-with-approval" },
        info,
      ),
    ).toEqual([{ chatId: CLUB, members: "anyone", userIds: [], hearAll: false }]);
  });

  it("hear everything is part of the rule (23.11)", () => {
    expect(
      sharedGroupAccessPushes(
        {
          allowedChatIds: [FAMILY, CLUB],
          groups: {
            [FAMILY]: { members: "selected", userIds: ["7", "8"], hearAll: true },
            [CLUB]: { members: "owners", userIds: [] },
          },
        },
        info,
      ),
    ).toEqual([{ chatId: FAMILY, members: "selected", userIds: ["7", "8"], hearAll: true }]);
    const heard = decodeSharedGroupsInfo({
      enabled: true,
      groups: [{ chat_id: CLUB, members: "owners", hear_all: true }],
    })!;
    // Turned off here: pushed as off.
    expect(
      sharedGroupAccessPushes(
        { allowedChatIds: [CLUB], groups: { [CLUB]: { members: "owners", userIds: [] } } },
        heard,
      ),
    ).toEqual([{ chatId: CLUB, members: "owners", userIds: [], hearAll: false }]);
  });
});

describe("sharedGroupsToAdd", () => {
  it("groups the console bound here that aren't added yet (23.11)", () => {
    const info = decodeSharedGroupsInfo({
      enabled: true,
      groups: [{ chat_id: FAMILY }, { chat_id: CLUB }],
    })!;
    expect(sharedGroupsToAdd({ allowedChatIds: ["777", FAMILY] }, info)).toEqual([CLUB]);
    expect(sharedGroupsToAdd({ allowedChatIds: [] }, { ...info, enabled: false })).toEqual([]);
  });
});
