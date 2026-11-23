import { describe, expect, it } from "vitest";

import {
  decodeSharedGroupsInfo,
  sharedGroupAccessBody,
  sharedGroupAccessPushes,
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
        groups: [
          {
            chat_id: FAMILY,
            title: "  Family\n chat ",
            members: "selected",
            user_ids: ["7", 8, "x", "-1"],
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
      groups: [
        {
          chatId: FAMILY,
          title: "Family chat",
          members: "selected",
          userIds: ["7", "8"],
          host: true,
          accounts: 2,
        },
        { chatId: CLUB, title: null, members: "owners", userIds: [], host: false, accounts: 1 },
      ],
    });
  });

  it("groups off: no groups, whatever came along", () => {
    expect(decodeSharedGroupsInfo({ enabled: false, groups: [{ chat_id: FAMILY }] })).toEqual({
      enabled: false,
      botUsername: null,
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
      { chatId: FAMILY, members: "selected", userIds: ["7"] },
      { chatId: CLUB, members: "anyone", userIds: [] },
    ]);
    expect(sharedGroupAccessBody(pushes[0]!)).toEqual({
      chat_id: FAMILY,
      members: "selected",
      user_ids: ["7"],
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
    ).toEqual([{ chatId: CLUB, members: "anyone", userIds: [] }]);
  });
});
