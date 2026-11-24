import { describe, expect, it } from "vitest";

import {
  approvalButtons,
  replyButtons,
  toolApprovalButtons,
  type ButtonGroup,
  type ConnectorButtonsState,
} from "./connectorButtons.ts";
import {
  decideSlackPress,
  parseSlackPress,
  slackButtonBlocks,
  slackFinishedBlocks,
  slackPressableRows,
} from "./slackButtons.ts";

const group = (over: Partial<ButtonGroup> = {}): ButtonGroup => ({
  id: "grp123456",
  connectorProjectId: "assistant",
  chatId: "C1",
  messageId: null,
  slackTs: "1700.1",
  threadId: "thread-1",
  rows: approvalButtons("req-1", "en"),
  createdAtMs: 0,
  expiresAtMs: 10_000,
  ...over,
});

const stateOf = (...groups: ButtonGroup[]): ConnectorButtonsState => ({ groups, routes: [] });

const press = (over: Record<string, unknown> = {}) => ({
  type: "block_actions",
  user: { id: "UOWNER" },
  container: { type: "message", channel_id: "C1", message_ts: "1700.1" },
  actions: [{ action_id: "ub1:grp123456:0" }],
  ...over,
});

describe("slackPressableRows", () => {
  it("takes approvals only; other buttons stay numbered options", () => {
    expect(slackPressableRows(approvalButtons("r", "en")).flat()).toHaveLength(2);
    expect(slackPressableRows(toolApprovalButtons("r", "en")).flat()).toHaveLength(2);
    expect(slackPressableRows(replyButtons([[{ label: "Yes", value: "yes" }]]))).toEqual([]);
    expect(slackPressableRows([])).toEqual([]);
  });
});

describe("slackButtonBlocks", () => {
  it("text, Allow (primary) / Deny (danger) with our action ids, then the Uno Work line", () => {
    const blocks = slackButtonBlocks("*Build*", group(), "en");
    expect(blocks.map((block) => block.type)).toEqual(["section", "actions", "context"]);
    expect(blocks[1]).toMatchObject({
      elements: [
        { action_id: "ub1:grp123456:0", style: "primary", text: { text: "✅ Allow" } },
        { action_id: "ub1:grp123456:1", style: "danger", text: { text: "✖ Deny" } },
      ],
    });
    expect(JSON.stringify(blocks[2])).toContain("Or open Uno Work to answer");
    expect(JSON.stringify(slackButtonBlocks("x", group(), "ru")[2])).toContain("откройте Uno Work");
  });

  it("answered: no actions block", () => {
    const blocks = slackFinishedBlocks("Build", "✔ ✅ Allow");
    expect(blocks.map((block) => block.type)).toEqual(["section", "context"]);
  });
});

describe("parseSlackPress", () => {
  it("reads a button press on a message", () => {
    expect(parseSlackPress(press())).toEqual({
      userId: "UOWNER",
      channel: "C1",
      messageTs: "1700.1",
      actionId: "ub1:grp123456:0",
    });
  });

  it("falls back to channel / message for older payload shapes", () => {
    expect(
      parseSlackPress(
        press({ container: undefined, channel: { id: "C2" }, message: { ts: "1.2" } }),
      ),
    ).toMatchObject({ channel: "C2", messageTs: "1.2" });
  });

  it("ignores other interactions and malformed payloads", () => {
    expect(parseSlackPress(press({ type: "view_submission" }))).toBeNull();
    expect(parseSlackPress(press({ actions: [] }))).toBeNull();
    expect(parseSlackPress(press({ user: {} }))).toBeNull();
    expect(parseSlackPress(null)).toBeNull();
  });
});

describe("decideSlackPress", () => {
  const decide = (over: { senderIsOwner?: boolean; payload?: Record<string, unknown> } = {}) =>
    decideSlackPress({
      state: stateOf(group()),
      press: parseSlackPress(press(over.payload))!,
      connectorProjectId: "assistant",
      senderIsOwner: over.senderIsOwner ?? true,
      nowMs: 1_000,
    }).kind;

  it("the owner's press on the message is ok", () => {
    expect(decide()).toBe("ok");
  });

  it("anyone else is refused", () => {
    expect(decide({ senderIsOwner: false })).toBe("forbidden");
  });

  it("the same action id on another message does nothing", () => {
    expect(decide({ payload: { container: { channel_id: "C1", message_ts: "1700.9" } } })).toBe(
      "unknown",
    );
  });

  it("another channel does nothing", () => {
    expect(decide({ payload: { container: { channel_id: "C9", message_ts: "1700.1" } } })).toBe(
      "unknown",
    );
  });

  it("a spent or expired group is expired", () => {
    expect(
      decideSlackPress({
        state: stateOf(),
        press: parseSlackPress(press())!,
        connectorProjectId: "assistant",
        senderIsOwner: true,
        nowMs: 1_000,
      }).kind,
    ).toBe("expired");
  });
});
