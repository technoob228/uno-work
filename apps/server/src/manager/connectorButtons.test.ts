import { describe, expect, it } from "vitest";

import {
  addButtonGroup,
  addSentMessageRoute,
  approvalButtons,
  approvalMessageText,
  buildInlineKeyboard,
  callbackDataFor,
  CHOICE_BUTTONS_TTL_MS,
  decideButtonPress,
  decodeButtonsState,
  EMPTY_BUTTONS_STATE,
  findReplyRoute,
  groupsForRequest,
  newButtonGroupId,
  normalizeButtonRows,
  parseCallbackData,
  pruneButtonsState,
  removeButtonGroup,
  replyButtons,
  REPLY_ROUTE_TTL_MS,
  setGroupMessageId,
  type ButtonGroup,
} from "./connectorButtons.ts";

const NOW = 1_800_000_000_000;

const group = (overrides: Partial<ButtonGroup> = {}): ButtonGroup => ({
  id: "grp123456",
  connectorProjectId: "assistant",
  chatId: "42",
  messageId: 7,
  threadId: "thread-1",
  rows: replyButtons([
    [
      { label: "Yes", value: "yes, go" },
      { label: "No", value: "No" },
    ],
  ]),
  createdAtMs: NOW,
  expiresAtMs: NOW + CHOICE_BUTTONS_TTL_MS,
  ...overrides,
});

describe("normalizeButtonRows", () => {
  it("lays out up to three short labels side by side", () => {
    const result = normalizeButtonRows([{ label: "Yes" }, { label: "No", value: "no thanks" }]);
    expect(result).toEqual({
      ok: true,
      rows: [
        [
          { label: "Yes", value: "Yes" },
          { label: "No", value: "no thanks" },
        ],
      ],
    });
  });

  it("puts long or many labels one per row; accepts plain strings", () => {
    const result = normalizeButtonRows(["A", "B", "C", "D"]);
    expect(result.ok && result.rows.map((row) => row.length)).toEqual([1, 1, 1, 1]);
    const long = normalizeButtonRows([{ label: "Deploy to production now" }, { label: "Wait" }]);
    expect(long.ok && long.rows.length).toBe(2);
  });

  it("keeps explicit rows", () => {
    const result = normalizeButtonRows([[{ label: "1" }, { label: "2" }], [{ label: "Cancel" }]]);
    expect(result.ok && result.rows.map((row) => row.map((button) => button.label))).toEqual([
      ["1", "2"],
      ["Cancel"],
    ]);
  });

  it("refuses empty, mixed, duplicate, oversized input", () => {
    expect(normalizeButtonRows([]).ok).toBe(false);
    expect(normalizeButtonRows("yes").ok).toBe(false);
    expect(normalizeButtonRows([{ label: "a" }, [{ label: "b" }]]).ok).toBe(false);
    expect(normalizeButtonRows([{ label: "a" }, { label: "a" }]).ok).toBe(false);
    expect(normalizeButtonRows([{ label: "x".repeat(41) }]).ok).toBe(false);
    expect(normalizeButtonRows([{ label: " " }]).ok).toBe(false);
    expect(normalizeButtonRows(Array.from({ length: 13 }, (_, i) => `b${i}`)).ok).toBe(false);
    expect(normalizeButtonRows([["1", "2", "3", "4", "5"]]).ok).toBe(false);
  });
});

describe("callback data and the keyboard", () => {
  it("fits Telegram's 64 bytes and round-trips", () => {
    const id = newButtonGroupId();
    const data = callbackDataFor(id, 11);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseCallbackData(data)).toEqual({ groupId: id, index: 11 });
  });

  it("ignores foreign callback data", () => {
    expect(parseCallbackData(undefined)).toBeNull();
    expect(parseCallbackData("approve")).toBeNull();
    expect(parseCallbackData("ub1:short:1")).toBeNull();
    expect(parseCallbackData("ub1:grp123456:x")).toBeNull();
  });

  it("numbers buttons in reading order across rows", () => {
    const keyboard = buildInlineKeyboard({
      id: "grp123456",
      rows: replyButtons([
        [{ label: "A", value: "a" }],
        [
          { label: "B", value: "b" },
          { label: "C", value: "c" },
        ],
      ]),
    });
    expect(keyboard).toEqual({
      inline_keyboard: [
        [{ text: "A", callback_data: "ub1:grp123456:0" }],
        [
          { text: "B", callback_data: "ub1:grp123456:1" },
          { text: "C", callback_data: "ub1:grp123456:2" },
        ],
      ],
    });
  });
});

describe("decideButtonPress", () => {
  const state = addButtonGroup(EMPTY_BUTTONS_STATE, group(), NOW);
  const press = (overrides: Partial<Parameters<typeof decideButtonPress>[0]> = {}) =>
    decideButtonPress({
      state,
      data: "ub1:grp123456:0",
      connectorProjectId: "assistant",
      chatId: "42",
      messageId: 7,
      senderIsOwner: true,
      nowMs: NOW + 1_000,
      ...overrides,
    });

  it("gives the owner the pressed button", () => {
    const result = press();
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.button.action).toEqual({
      kind: "reply",
      value: "yes, go",
    });
  });

  it("refuses anyone but the owner", () => {
    expect(press({ senderIsOwner: false }).kind).toBe("forbidden");
  });

  it("refuses another chat, bot or message", () => {
    expect(press({ chatId: "43" }).kind).toBe("unknown");
    expect(press({ connectorProjectId: "other" }).kind).toBe("unknown");
    expect(press({ messageId: 8 }).kind).toBe("unknown");
    expect(press({ data: "ub1:grp123456:5" }).kind).toBe("unknown");
    expect(press({ data: "something else" }).kind).toBe("unknown");
  });

  it("expires with the TTL and after the group is spent", () => {
    expect(press({ nowMs: NOW + CHOICE_BUTTONS_TTL_MS + 1 }).kind).toBe("expired");
    expect(press({ state: removeButtonGroup(state, "grp123456") }).kind).toBe("expired");
  });
});

describe("state", () => {
  it("records the message id after sending", () => {
    const pending = addButtonGroup(EMPTY_BUTTONS_STATE, group({ messageId: null }), NOW);
    const sent = setGroupMessageId(pending, "grp123456", 99);
    expect(sent.groups[0]?.messageId).toBe(99);
  });

  it("routes a reply to the chat that sent the message, within the TTL", () => {
    const state = addSentMessageRoute(
      EMPTY_BUTTONS_STATE,
      {
        connectorProjectId: "assistant",
        chatId: "42",
        messageId: 10,
        threadId: "work-1",
        atMs: NOW,
      },
      NOW,
    );
    const lookup = { connectorProjectId: "assistant", chatId: "42", messageId: 10, nowMs: NOW };
    expect(findReplyRoute(state, lookup)).toBe("work-1");
    expect(findReplyRoute(state, { ...lookup, messageId: 11 })).toBeNull();
    expect(findReplyRoute(state, { ...lookup, chatId: "43" })).toBeNull();
    expect(findReplyRoute(state, { ...lookup, nowMs: NOW + REPLY_ROUTE_TTL_MS })).toBeNull();
  });

  it("prunes expired groups and old routes", () => {
    const state = {
      groups: [group({ id: "old456789", expiresAtMs: NOW - 1 }), group()],
      routes: [
        {
          connectorProjectId: "a",
          chatId: "1",
          messageId: 1,
          threadId: "t",
          atMs: NOW - REPLY_ROUTE_TTL_MS,
        },
      ],
    };
    const pruned = pruneButtonsState(state, NOW);
    expect(pruned.groups.map((entry) => entry.id)).toEqual(["grp123456"]);
    expect(pruned.routes).toEqual([]);
  });

  it("finds the groups of an approval request", () => {
    const approval = group({ id: "appr12345", rows: approvalButtons("req-1", "en") });
    const state = addButtonGroup(addButtonGroup(EMPTY_BUTTONS_STATE, group(), NOW), approval, NOW);
    expect(groupsForRequest(state, "req-1").map((entry) => entry.id)).toEqual(["appr12345"]);
    expect(groupsForRequest(state, "req-2")).toEqual([]);
  });

  it("survives a malformed file", () => {
    expect(decodeButtonsState(null)).toEqual(EMPTY_BUTTONS_STATE);
    expect(decodeButtonsState({ groups: [{ id: 1 }, group()], routes: "x" })).toEqual({
      groups: [group()],
      routes: [],
    });
  });
});

describe("approval texts", () => {
  it("names the chat and what it wants", () => {
    expect(
      approvalMessageText({
        threadTitle: "Fix login",
        requestKind: "command",
        detail: "npm install",
        language: "ru",
      }),
    ).toBe("💬 Fix login: хочет выполнить команду:\nnpm install");
    expect(
      approvalMessageText({
        threadTitle: "Fix login",
        requestKind: null,
        detail: null,
        language: "en",
      }),
    ).toBe("💬 Fix login: wants to take a step");
  });
});
