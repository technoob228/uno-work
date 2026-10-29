/**
 * Inline buttons and reply routing for messages chats send to the person's
 * Telegram (`messenger_send`, approval requests) — the pure half.
 *
 * - **Buttons.** A message may carry a few buttons (a choice of answers, or
 *   Allow / Deny). Telegram gives a button at most 64 bytes of
 *   `callback_data`, so a button carries only `ub1:<group>:<index>`; what it
 *   means — which chat it answers, the value or the request it resolves —
 *   is a {@link ButtonGroup} kept here, with a TTL. One group per message:
 *   the first press spends the whole group (the message then shows
 *   "✔ <label>" and loses its buttons).
 * - **Reply routing.** A message a work chat sent is marked with the chat's
 *   name ("💬 <title>"); the person's Telegram reply to it goes back to that
 *   chat, not to the bot's default target. {@link SentMessageRoute} maps the
 *   sent `message_id` to the thread.
 *
 * The state is a plain value: the connector keeps it in a Ref and on disk
 * (`connector-buttons.json` in the state dir), so a daemon restart (an
 * update) does not turn every button into "expired".
 *
 * @module manager/connectorButtons
 */
import * as crypto from "node:crypto";

import type { ReplyLanguage } from "./connectorReplyText.ts";

// ── Limits ───────────────────────────────────────────────────────────────

/** Buttons per message: a choice, not a menu. */
export const MAX_BUTTONS = 12;
export const MAX_BUTTON_ROWS = 6;
export const MAX_BUTTONS_PER_ROW = 4;
/** A label Telegram shows in full on a phone. */
export const MAX_BUTTON_LABEL_CHARS = 40;
/** What a press sends to the chat as the person's answer. */
export const MAX_BUTTON_VALUE_CHARS = 500;
/** A choice is answered within days or never. */
export const CHOICE_BUTTONS_TTL_MS = 3 * 24 * 60 * 60_000;
/** Approval requests (harness and Uno Work) are dropped by their owners sooner. */
export const APPROVAL_BUTTONS_TTL_MS = 24 * 60 * 60_000;
/** How long a reply to a chat's message still goes back to that chat. */
export const REPLY_ROUTE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_GROUPS = 500;
const MAX_ROUTES = 2_000;

/** Prefix of our `callback_data` (versioned: a future format can coexist). */
const CALLBACK_PREFIX = "ub1";

// ── Types ────────────────────────────────────────────────────────────────

/** A button as an agent asks for it. `value` defaults to the label. */
export interface ButtonSpec {
  readonly label: string;
  readonly value: string;
}

/** What pressing a button does. */
export type ConnectorButtonAction =
  /** The value goes to the chat as the person's message. */
  | { readonly kind: "reply"; readonly value: string }
  /** A harness approval request of the chat (`thread.approval.respond`). */
  | {
      readonly kind: "approval";
      readonly requestId: string;
      readonly decision: "accept" | "decline";
    }
  /** A Uno Work tool approval (the card, `personApproval.ts`). */
  | { readonly kind: "tool-approval"; readonly requestId: string; readonly approved: boolean };

export interface ConnectorButton {
  readonly label: string;
  readonly action: ConnectorButtonAction;
}

export interface ButtonGroup {
  readonly id: string;
  /** The connector (bot) that sent it: a press must come through the same bot. */
  readonly connectorProjectId: string;
  readonly chatId: string;
  /** Set once Telegram accepted the message. */
  readonly messageId: number | null;
  /** The chat the buttons answer. */
  readonly threadId: string;
  readonly rows: ReadonlyArray<ReadonlyArray<ConnectorButton>>;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface SentMessageRoute {
  readonly connectorProjectId: string;
  readonly chatId: string;
  readonly messageId: number;
  readonly threadId: string;
  readonly atMs: number;
}

export interface ConnectorButtonsState {
  readonly groups: ReadonlyArray<ButtonGroup>;
  readonly routes: ReadonlyArray<SentMessageRoute>;
}

export const EMPTY_BUTTONS_STATE: ConnectorButtonsState = { groups: [], routes: [] };

// ── Input from agents ────────────────────────────────────────────────────

const cleanLabel = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const label = raw.replace(/\s+/g, " ").trim();
  return label.length === 0 ? null : label;
};

const parseButton = (raw: unknown): ButtonSpec | string => {
  if (typeof raw === "string") {
    const label = cleanLabel(raw);
    return label === null ? "a button needs a label" : { label, value: label };
  }
  if (typeof raw !== "object" || raw === null) return "a button is {label, value}";
  const record = raw as { readonly label?: unknown; readonly value?: unknown };
  const label = cleanLabel(record.label);
  if (label === null) return "a button needs a label";
  if (label.length > MAX_BUTTON_LABEL_CHARS) {
    return `the label "${label.slice(0, 20)}…" is over ${MAX_BUTTON_LABEL_CHARS} characters`;
  }
  const value =
    typeof record.value === "string" && record.value.trim().length > 0
      ? record.value.trim()
      : label;
  if (value.length > MAX_BUTTON_VALUE_CHARS) {
    return `a value is over ${MAX_BUTTON_VALUE_CHARS} characters`;
  }
  return { label, value };
};

/**
 * `buttons` of a tool call: a flat list (laid out here: up to three short
 * labels side by side, otherwise one per row) or explicit rows.
 */
export const normalizeButtonRows = (
  raw: unknown,
):
  | { readonly ok: true; readonly rows: ReadonlyArray<ReadonlyArray<ButtonSpec>> }
  | { readonly ok: false; readonly error: string } => {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "buttons must be a non-empty list" };
  }
  const nested = raw.every((entry) => Array.isArray(entry));
  if (!nested && raw.some((entry) => Array.isArray(entry))) {
    return { ok: false, error: "give either a list of buttons or a list of rows, not both" };
  }
  const rawRows: ReadonlyArray<ReadonlyArray<unknown>> = nested
    ? (raw as ReadonlyArray<ReadonlyArray<unknown>>)
    : [raw];
  const rows: Array<Array<ButtonSpec>> = [];
  for (const rawRow of rawRows) {
    const row: Array<ButtonSpec> = [];
    for (const entry of rawRow) {
      const button = parseButton(entry);
      if (typeof button === "string") return { ok: false, error: button };
      row.push(button);
    }
    if (row.length > 0) rows.push(row);
  }
  const all = rows.flat();
  if (all.length === 0) return { ok: false, error: "buttons must be a non-empty list" };
  if (all.length > MAX_BUTTONS) {
    return { ok: false, error: `at most ${MAX_BUTTONS} buttons` };
  }
  if (new Set(all.map((button) => button.label)).size !== all.length) {
    return { ok: false, error: "two buttons have the same label" };
  }
  if (nested) {
    if (rows.length > MAX_BUTTON_ROWS) {
      return { ok: false, error: `at most ${MAX_BUTTON_ROWS} rows` };
    }
    if (rows.some((row) => row.length > MAX_BUTTONS_PER_ROW)) {
      return { ok: false, error: `at most ${MAX_BUTTONS_PER_ROW} buttons in a row` };
    }
    return { ok: true, rows };
  }
  const sideBySide = all.length <= 3 && all.every((button) => button.label.length <= 14);
  return { ok: true, rows: sideBySide ? [all] : all.map((button) => [button]) };
};

/** Agent buttons as actions: each answers with its value. */
export const replyButtons = (
  rows: ReadonlyArray<ReadonlyArray<ButtonSpec>>,
): ReadonlyArray<ReadonlyArray<ConnectorButton>> =>
  rows.map((row) =>
    row.map((button) => ({
      label: button.label,
      action: { kind: "reply", value: button.value } as const,
    })),
  );

/** The flat list in the order shown — for a channel without buttons (Slack). */
export const buttonsAsText = (
  rows: ReadonlyArray<ReadonlyArray<{ readonly label: string }>>,
  language: ReplyLanguage,
): string => {
  const labels = rows.flat().map((button) => button.label);
  return `${language === "ru" ? "Варианты" : "Options"}: ${labels.join(" · ")}`;
};

// ── Telegram wire format ─────────────────────────────────────────────────

export const newButtonGroupId = (): string => crypto.randomBytes(9).toString("base64url");

export const callbackDataFor = (groupId: string, index: number): string =>
  `${CALLBACK_PREFIX}:${groupId}:${index}`;

export const parseCallbackData = (
  data: string | undefined,
): { readonly groupId: string; readonly index: number } | null => {
  if (typeof data !== "string") return null;
  const match = /^ub1:([A-Za-z0-9_-]{6,32}):(\d{1,2})$/.exec(data);
  if (match === null) return null;
  return { groupId: match[1]!, index: Number(match[2]) };
};

export interface TelegramInlineButton {
  readonly text: string;
  readonly callback_data: string;
}

/** `reply_markup` of the message: the group's rows, buttons numbered in reading order. */
export const buildInlineKeyboard = (
  group: Pick<ButtonGroup, "id" | "rows">,
): { readonly inline_keyboard: ReadonlyArray<ReadonlyArray<TelegramInlineButton>> } => {
  let index = 0;
  return {
    inline_keyboard: group.rows.map((row) =>
      row.map((button) => ({
        text: button.label,
        callback_data: callbackDataFor(group.id, index++),
      })),
    ),
  };
};

const buttonAt = (group: ButtonGroup, index: number): ConnectorButton | null =>
  group.rows.flat()[index] ?? null;

// ── State ────────────────────────────────────────────────────────────────

export const pruneButtonsState = (
  state: ConnectorButtonsState,
  nowMs: number,
): ConnectorButtonsState => ({
  groups: state.groups.filter((group) => group.expiresAtMs > nowMs).slice(-MAX_GROUPS),
  routes: state.routes
    .filter((route) => nowMs - route.atMs < REPLY_ROUTE_TTL_MS)
    .slice(-MAX_ROUTES),
});

export const addButtonGroup = (
  state: ConnectorButtonsState,
  group: ButtonGroup,
  nowMs: number,
): ConnectorButtonsState => {
  const pruned = pruneButtonsState(state, nowMs);
  return { ...pruned, groups: [...pruned.groups, group].slice(-MAX_GROUPS) };
};

export const setGroupMessageId = (
  state: ConnectorButtonsState,
  groupId: string,
  messageId: number,
): ConnectorButtonsState => ({
  ...state,
  groups: state.groups.map((group) => (group.id === groupId ? { ...group, messageId } : group)),
});

export const removeButtonGroup = (
  state: ConnectorButtonsState,
  groupId: string,
): ConnectorButtonsState => ({
  ...state,
  groups: state.groups.filter((group) => group.id !== groupId),
});

export const addSentMessageRoute = (
  state: ConnectorButtonsState,
  route: SentMessageRoute,
  nowMs: number,
): ConnectorButtonsState => {
  const pruned = pruneButtonsState(state, nowMs);
  return { ...pruned, routes: [...pruned.routes, route].slice(-MAX_ROUTES) };
};

/** The chat a reply to one of our messages goes to, or null. */
export const findReplyRoute = (
  state: ConnectorButtonsState,
  input: {
    readonly connectorProjectId: string;
    readonly chatId: string;
    readonly messageId: number;
    readonly nowMs: number;
  },
): string | null =>
  state.routes.find(
    (route) =>
      route.connectorProjectId === input.connectorProjectId &&
      route.chatId === input.chatId &&
      route.messageId === input.messageId &&
      input.nowMs - route.atMs < REPLY_ROUTE_TTL_MS,
  )?.threadId ?? null;

/** Open groups whose buttons answer this approval request (to retire them). */
export const groupsForRequest = (
  state: ConnectorButtonsState,
  requestId: string,
): ReadonlyArray<ButtonGroup> =>
  state.groups.filter((group) =>
    group.rows
      .flat()
      .some(
        (button) =>
          (button.action.kind === "approval" || button.action.kind === "tool-approval") &&
          button.action.requestId === requestId,
      ),
  );

/** Drop malformed entries of a state read from disk. */
export const decodeButtonsState = (raw: unknown): ConnectorButtonsState => {
  if (typeof raw !== "object" || raw === null) return EMPTY_BUTTONS_STATE;
  const record = raw as { readonly groups?: unknown; readonly routes?: unknown };
  const groups = Array.isArray(record.groups)
    ? record.groups.filter(
        (group): group is ButtonGroup =>
          typeof group === "object" &&
          group !== null &&
          typeof group.id === "string" &&
          typeof group.chatId === "string" &&
          typeof group.connectorProjectId === "string" &&
          typeof group.threadId === "string" &&
          typeof group.expiresAtMs === "number" &&
          Array.isArray(group.rows),
      )
    : [];
  const routes = Array.isArray(record.routes)
    ? record.routes.filter(
        (route): route is SentMessageRoute =>
          typeof route === "object" &&
          route !== null &&
          typeof route.chatId === "string" &&
          typeof route.connectorProjectId === "string" &&
          typeof route.threadId === "string" &&
          typeof route.messageId === "number" &&
          typeof route.atMs === "number",
      )
    : [];
  return { groups, routes };
};

// ── A press ──────────────────────────────────────────────────────────────

export type ButtonPress =
  | { readonly kind: "unknown" }
  | { readonly kind: "expired" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "ok"; readonly group: ButtonGroup; readonly button: ConnectorButton };

/**
 * What a `callback_query` means. Only the owner may press (an allowlisted
 * group is not an allowlisted person: `senderRole` comes from the
 * connector's sender policy), only in the chat and on the bot the message
 * went to, only while the group lives.
 */
export const decideButtonPress = (input: {
  readonly state: ConnectorButtonsState;
  readonly data: string | undefined;
  readonly connectorProjectId: string;
  readonly chatId: string;
  readonly messageId: number | undefined;
  readonly senderIsOwner: boolean;
  readonly nowMs: number;
}): ButtonPress => {
  const parsed = parseCallbackData(input.data);
  if (parsed === null) return { kind: "unknown" };
  const group = input.state.groups.find((candidate) => candidate.id === parsed.groupId);
  if (group === undefined || group.expiresAtMs <= input.nowMs) return { kind: "expired" };
  if (
    group.connectorProjectId !== input.connectorProjectId ||
    group.chatId !== input.chatId ||
    (group.messageId !== null &&
      input.messageId !== undefined &&
      group.messageId !== input.messageId)
  ) {
    return { kind: "unknown" };
  }
  if (!input.senderIsOwner) return { kind: "forbidden" };
  const button = buttonAt(group, parsed.index);
  if (button === null) return { kind: "unknown" };
  return { kind: "ok", group, button };
};

// ── Texts ────────────────────────────────────────────────────────────────

/** First line of a message a work chat sends: whose it is. */
export const chatHeaderLine = (threadTitle: string): string =>
  `💬 ${threadTitle.replace(/\s+/g, " ").trim().slice(0, 80)}`;

/** Appended to the message once a button was pressed (its buttons go). */
export const pressedLine = (label: string): string => `✔ ${label}`;

export const pressToastText = (
  press: Exclude<ButtonPress["kind"], "ok">,
  language: ReplyLanguage,
): string => {
  const ru = language === "ru";
  switch (press) {
    case "expired":
      return ru
        ? "Эта кнопка устарела. Ответьте текстом."
        : "This button has expired. Answer in a message instead.";
    case "forbidden":
      return ru ? "Ответить может только владелец." : "Only the owner can answer this.";
    case "unknown":
      return ru ? "Эта кнопка больше не работает." : "This button no longer works.";
  }
};

export type ApprovalRequestKind = "command" | "file-read" | "file-change" | null;

const approvalWhat = (kind: ApprovalRequestKind, language: ReplyLanguage): string => {
  if (language === "ru") {
    switch (kind) {
      case "command":
        return "выполнить команду";
      case "file-read":
        return "прочитать файл";
      case "file-change":
        return "изменить файлы";
      default:
        return "сделать шаг";
    }
  }
  switch (kind) {
    case "command":
      return "run a command";
    case "file-read":
      return "read a file";
    case "file-change":
      return "change files";
    default:
      return "take a step";
  }
};

const APPROVAL_DETAIL_CHARS = 300;

/** "💬 <chat>: хочет выполнить команду — `npm i`" + Allow / Deny. */
export const approvalMessageText = (input: {
  readonly threadTitle: string;
  readonly requestKind: ApprovalRequestKind;
  readonly detail: string | null;
  readonly language: ReplyLanguage;
}): string => {
  const head = `${chatHeaderLine(input.threadTitle)}: ${
    input.language === "ru" ? "хочет" : "wants to"
  } ${approvalWhat(input.requestKind, input.language)}`;
  const detail = input.detail?.trim().slice(0, APPROVAL_DETAIL_CHARS) ?? "";
  return detail.length === 0 ? head : `${head}:\n${detail}`;
};

/** Allow / Deny of a harness approval request. */
export const approvalButtons = (
  requestId: string,
  language: ReplyLanguage,
): ReadonlyArray<ReadonlyArray<ConnectorButton>> => [
  [
    {
      label: language === "ru" ? "✅ Разрешить" : "✅ Allow",
      action: { kind: "approval", requestId, decision: "accept" },
    },
    {
      label: language === "ru" ? "✖ Отклонить" : "✖ Deny",
      action: { kind: "approval", requestId, decision: "decline" },
    },
  ],
];

/** Allow / Deny of a Uno Work tool approval (the card). */
export const toolApprovalButtons = (
  requestId: string,
  language: ReplyLanguage,
): ReadonlyArray<ReadonlyArray<ConnectorButton>> => [
  [
    {
      label: language === "ru" ? "✅ Разрешить" : "✅ Allow",
      action: { kind: "tool-approval", requestId, approved: true },
    },
    {
      label: language === "ru" ? "✖ Отклонить" : "✖ Deny",
      action: { kind: "tool-approval", requestId, approved: false },
    },
  ],
];

/** The line a message gets when its request was answered elsewhere (the app, /approve). */
export const answeredElsewhereLine = (language: ReplyLanguage): string =>
  language === "ru" ? "✔ Уже решено" : "✔ Already answered";

/** A press found the request no longer waiting. */
export const requestGoneLine = (language: ReplyLanguage): string =>
  language === "ru" ? "Запрос уже не ждёт ответа." : "This request is no longer waiting.";
