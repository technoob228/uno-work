/**
 * Allow / Decline buttons in Slack (23.11, Misha: approvals answered right in
 * Slack, as in Telegram) — the pure half.
 *
 * An approval request (a harness step or a Uno Work tool) goes to Slack as one
 * message with Block Kit buttons. A button's `action_id` is the same
 * `ub1:<group>:<index>` a Telegram button carries; what it means lives in a
 * {@link ButtonGroup} (connectorButtons.ts), kept by the Slack connector in
 * `slack-buttons.json`. The press comes back as a `block_actions` payload —
 * through Uno's console (its Interactivity URL, relay mode) or the own app's
 * Socket Mode — and is decided exactly like a Telegram `callback_query`
 * (`decideButtonPress`: only the owner, only that message, while it lives).
 *
 * Buttons need Interactivity in the Slack app. An app without it (created
 * before 23.11, an own bot made from an older manifest) shows them but a
 * press does nothing — so the message keeps the "open Uno Work" line.
 *
 * @module manager/slackButtons
 */
import {
  callbackDataFor,
  decideButtonPress,
  type ButtonGroup,
  type ButtonPress,
  type ConnectorButton,
  type ConnectorButtonsState,
} from "./connectorButtons.ts";
import type { ReplyLanguage } from "./connectorReplyText.ts";

/** Slack's limits: section text 3000 chars, button text 75, 25 elements per actions block. */
const SECTION_TEXT_LIMIT = 3000;
const BUTTON_TEXT_LIMIT = 75;
const ACTIONS_LIMIT = 25;

/** The kinds of buttons Slack gets as real buttons (the rest stay numbered options). */
export const isSlackButtonAction = (button: ConnectorButton): boolean =>
  button.action.kind === "approval" || button.action.kind === "tool-approval";

/** Rows whose every button Slack can press (approvals). Empty: not for Slack buttons. */
export const slackPressableRows = (
  rows: ReadonlyArray<ReadonlyArray<ConnectorButton>>,
): ReadonlyArray<ReadonlyArray<ConnectorButton>> => {
  const flat = rows.flat();
  return flat.length > 0 && flat.every(isSlackButtonAction) ? rows : [];
};

/** Under the buttons: the way to answer that works without them. */
export const slackApprovalFallbackLine = (language: ReplyLanguage): string =>
  language === "ru"
    ? "Или откройте Uno Work и ответьте там (Входящие или чат)."
    : "Or open Uno Work to answer (Inbox or the chat).";

const styleOf = (button: ConnectorButton): "primary" | "danger" | undefined => {
  const action = button.action;
  if (action.kind === "approval") return action.decision === "accept" ? "primary" : "danger";
  if (action.kind === "tool-approval") return action.approved ? "primary" : "danger";
  return undefined;
};

export interface SlackBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

const section = (text: string): SlackBlock => ({
  type: "section",
  text: { type: "mrkdwn", text: text.slice(0, SECTION_TEXT_LIMIT) || " " },
});

const context = (text: string): SlackBlock => ({
  type: "context",
  elements: [{ type: "mrkdwn", text: text.slice(0, SECTION_TEXT_LIMIT) }],
});

/** The message: its text, the buttons, the fallback line. `text` is Slack mrkdwn already. */
export const slackButtonBlocks = (
  text: string,
  group: Pick<ButtonGroup, "id" | "rows">,
  language: ReplyLanguage,
): ReadonlyArray<SlackBlock> => [
  section(text),
  {
    type: "actions",
    block_id: `ub1:${group.id}`,
    elements: group.rows
      .flat()
      .slice(0, ACTIONS_LIMIT)
      .map((button, index) => {
        const style = styleOf(button);
        return {
          type: "button",
          action_id: callbackDataFor(group.id, index),
          text: { type: "plain_text", text: button.label.slice(0, BUTTON_TEXT_LIMIT), emoji: true },
          value: String(index),
          ...(style !== undefined ? { style } : {}),
        };
      }),
  },
  context(slackApprovalFallbackLine(language)),
];

/** The message once answered: its text and "✔ Allow" — no buttons. */
export const slackFinishedBlocks = (text: string, line: string): ReadonlyArray<SlackBlock> => [
  section(text),
  context(line),
];

/** What the connector reads of a `block_actions` payload. */
export interface SlackPress {
  readonly userId: string;
  readonly channel: string;
  readonly messageTs: string;
  readonly actionId: string;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const obj = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** A button press on a message, or null (another interaction, or malformed). */
export const parseSlackPress = (payload: unknown): SlackPress | null => {
  const body = obj(payload);
  if (body.type !== "block_actions") return null;
  const container = obj(body.container);
  const message = obj(body.message);
  const channel = str(container.channel_id) || str(obj(body.channel).id);
  const messageTs = str(container.message_ts) || str(message.ts);
  const userId = str(obj(body.user).id);
  const actions = Array.isArray(body.actions) ? body.actions : [];
  const actionId = str(obj(actions[0]).action_id);
  if (channel === "" || messageTs === "" || userId === "" || actionId === "") return null;
  return { userId, channel, messageTs, actionId };
};

/**
 * What a press means: {@link decideButtonPress} (owner, chat, connector,
 * TTL) plus the Slack message — a group answers only presses on the message
 * it was sent with.
 */
export const decideSlackPress = (input: {
  readonly state: ConnectorButtonsState;
  readonly press: SlackPress;
  readonly connectorProjectId: string;
  readonly senderIsOwner: boolean;
  readonly nowMs: number;
}): ButtonPress => {
  const decided = decideButtonPress({
    state: input.state,
    data: input.press.actionId,
    connectorProjectId: input.connectorProjectId,
    chatId: input.press.channel,
    messageId: undefined,
    senderIsOwner: input.senderIsOwner,
    nowMs: input.nowMs,
  });
  if (decided.kind !== "ok" && decided.kind !== "forbidden") return decided;
  const group = input.state.groups.find(
    (candidate) => candidate.id === input.press.actionId.split(":")[1],
  );
  if (group?.slackTs !== undefined && group.slackTs !== input.press.messageTs) {
    return { kind: "unknown" };
  }
  return decided;
};
