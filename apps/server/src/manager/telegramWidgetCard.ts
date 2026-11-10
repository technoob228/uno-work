/**
 * Telegram widgets (Bot API 10.4, `sendWidget`) — the pure half.
 *
 * - **Cards** (`show_card`): in a private chat a choice, a report or a quiz
 *   goes first as a widget (`@t3tools/shared/personCardWidget`); refused or
 *   not drawable → the Rich Message / polls as before (telegramRichCard.ts).
 *   The card keeps its ButtonGroup (choice, report: values, TTL, replies) or
 *   CardQuiz (a quiz: answers, idle flush), marked `widget`. A tap arrives
 *   as a `widget_query` with `w1:<id>:<hexmask>` (a quiz:
 *   `w1:<id>:<question>.<hexmask>`); the bot answers it with the card's
 *   state (JSON), mirrors that into the message's `chat_data` and sends the
 *   person's message to the chat — once.
 * - **An agent's own widget** (`messenger_send` `widget`): any request text
 *   goes to the chat that sent it as the person's message
 *   (`[from the widget «…»]`), the bot answers `{"ok":1}`; `widget_update`
 *   edits the last one's `chat_data`.
 *
 * @module manager/telegramWidgetCard
 */
import { deflateSync } from "node:zlib";

import { withHtmlRenderMessageMarker } from "@t3tools/shared/htmlRender";
import {
  PERSON_CARD_WIDGET_EXPIRED,
  PERSON_CARD_WIDGET_LIMITS,
  widgetPickState,
  widgetQuizState,
} from "@t3tools/shared/personCardWidget";

import type {
  AgentWidget,
  ButtonGroup,
  CardQuiz,
  ConnectorButtonsState,
} from "./connectorButtons.ts";
import type { ReplyLanguage } from "./connectorReplyText.ts";
import { answerQuiz, pickedMessage } from "./telegramRichCard.ts";

// ── Limits ───────────────────────────────────────────────────────────────

export const WIDGET_HTML_MAX_BYTES = PERSON_CARD_WIDGET_LIMITS.htmlBytes;
/** Telegram's limit is 4096 zlib bytes "at max level"; our deflate may differ a little. */
export const WIDGET_ZLIB_MAX_BYTES = 4000;
export const WIDGET_STATE_MAX_BYTES = PERSON_CARD_WIDGET_LIMITS.chatDataBytes;
export const WIDGET_CAPTION_MAX_CHARS = PERSON_CARD_WIDGET_LIMITS.captionChars;
/** Height Telegram clamps to (50–600); width (200–bubble). */
export const WIDGET_MIN_HEIGHT = 50;
export const WIDGET_MAX_HEIGHT = 600;
export const WIDGET_MIN_WIDTH = 200;
/** An agent's widget answers its chat this long; `widget_update` finds it this long. */
export const AGENT_WIDGET_TTL_MS = 7 * 24 * 60 * 60_000;
/** Requests of one agent widget that reach its chat per minute (Telegram: 5 per 5 s anyway). */
export const AGENT_WIDGET_REQUESTS_PER_MINUTE = 12;

export const WIDGET_EXPIRED_STATE = PERSON_CARD_WIDGET_EXPIRED;
/** What an agent widget's request gets back when it reached the chat. */
export const AGENT_WIDGET_OK = '{"ok":1}';
/** …and when it came too fast (not sent to the chat). */
export const AGENT_WIDGET_SLOW = '{"ok":0,"e":"slow"}';

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Bytes of the html as Telegram measures it: raw, and deflated at level 9. */
export const widgetSize = (html: string) => ({
  bytes: utf8Bytes(html),
  zlib: deflateSync(Buffer.from(html, "utf8"), { level: 9 }).length,
});

/** Why this html can't be a widget, or null. */
export const widgetSizeProblem = (html: string): string | null => {
  if (html.trim().length === 0) return "html is empty";
  const size = widgetSize(html);
  if (size.bytes > WIDGET_HTML_MAX_BYTES) {
    return `html is ${size.bytes} bytes; at most ${WIDGET_HTML_MAX_BYTES}`;
  }
  if (size.zlib > WIDGET_ZLIB_MAX_BYTES) {
    return `too big when compressed: ${size.zlib} bytes of ${WIDGET_ZLIB_MAX_BYTES} — shorten the CSS/JS, no images`;
  }
  return null;
};

export const widgetFits = (html: string): boolean => widgetSizeProblem(html) === null;

// ── Requests ─────────────────────────────────────────────────────────────

const REQUEST_PREFIX = "w1";

export const widgetRequestPrefix = (id: string): string => `${REQUEST_PREFIX}:${id}:`;

export interface WidgetRequest {
  readonly id: string;
  /** A quiz question's index; null for a choice / report. */
  readonly question: number | null;
  /** The bits of the mask, ascending. */
  readonly picks: ReadonlyArray<number>;
}

/** A card's request (`w1:<id>:[<q>.]<hexmask>`), or null: not ours (an agent widget's text). */
export const parseWidgetRequest = (data: string | undefined): WidgetRequest | null => {
  if (typeof data !== "string") return null;
  const match = /^w1:([A-Za-z0-9_-]{6,32}):(?:(\d{1,2})\.)?([0-9a-f]{1,3})$/.exec(data);
  if (match === null) return null;
  const mask = Number.parseInt(match[3]!, 16);
  const picks: number[] = [];
  for (let bit = 0; bit < 12; bit += 1) if ((mask >> bit) & 1) picks.push(bit);
  if (picks.length === 0) return null;
  return {
    id: match[1]!,
    question: match[2] === undefined ? null : Number(match[2]),
    picks,
  };
};

/** Whether the data looks like a card's request at all (to tell "expired" from "an agent's text"). */
export const looksLikeCardRequest = (data: string | undefined): boolean =>
  typeof data === "string" && data.startsWith(`${REQUEST_PREFIX}:`);

// ── A choice / a report ──────────────────────────────────────────────────

export type WidgetPickVerdict =
  /** Not a pick this card can mean (stale or forged): answer the state, change nothing. */
  | { readonly kind: "bad"; readonly state: string }
  /** Answered before: the final state again, nothing to the chat. */
  | { readonly kind: "spent"; readonly state: string }
  | {
      readonly kind: "ok";
      readonly picks: ReadonlyArray<number>;
      /** The person's message to the chat. */
      readonly text: string;
      readonly state: string;
    };

/**
 * What a widget's tap means for its group: a choice option or a report
 * action (one `reply` button), or the picked toggles of a multiple choice.
 */
export const decideWidgetPick = (
  group: ButtonGroup,
  picks: ReadonlyArray<number>,
  language: ReplyLanguage,
): WidgetPickVerdict => {
  if (group.spent !== undefined) {
    return { kind: "spent", state: widgetPickState(group.spent, true) };
  }
  const current = widgetPickState([], false);
  const buttons = group.rows.flat();
  const toggles = buttons.filter((button) => button.action.kind === "toggle");
  if (toggles.length > 0) {
    if (picks.length === 0 || picks.some((index) => index >= toggles.length)) {
      return { kind: "bad", state: current };
    }
    const values = picks.map((index) => {
      const action = toggles[index]!.action;
      return action.kind === "toggle" ? action.value : "";
    });
    return {
      kind: "ok",
      picks,
      text: pickedMessage(values, language),
      state: widgetPickState(picks, true),
    };
  }
  const button = picks.length === 1 ? buttons[picks[0]!] : undefined;
  if (button === undefined || button.action.kind !== "reply")
    return { kind: "bad", state: current };
  return {
    kind: "ok",
    picks,
    text: button.action.value,
    state: widgetPickState(picks, true),
  };
};

/** Marks the group answered, only if nobody did first (a double tap): `applied` says who won. */
export const spendWidgetGroup = (
  state: ConnectorButtonsState,
  groupId: string,
  picks: ReadonlyArray<number>,
): { readonly state: ConnectorButtonsState; readonly applied: boolean } => {
  let applied = false;
  const groups = state.groups.map((group) => {
    if (group.id !== groupId || group.spent !== undefined) return group;
    applied = true;
    return { ...group, spent: [...picks] };
  });
  return { state: applied ? { ...state, groups } : state, applied };
};

/** The labels of the picked options / action, for the log. */
export const widgetPickLabels = (group: ButtonGroup, picks: ReadonlyArray<number>): string => {
  const buttons = group.rows.flat();
  const toggles = buttons.filter((button) => button.action.kind === "toggle");
  const pool = toggles.length > 0 ? toggles : buttons;
  return picks.map((index) => pool[index]?.label ?? "?").join(", ");
};

// ── A quiz ───────────────────────────────────────────────────────────────

export type WidgetQuizVerdict =
  /** A question answered already, or not reached: the current state, nothing changes. */
  | { readonly kind: "stale"; readonly state: string }
  | { readonly kind: "next" | "done"; readonly quiz: CardQuiz; readonly state: string };

/** One answered question of a widget quiz (`answerQuiz` on its current question). */
export const answerWidgetQuiz = (
  quiz: CardQuiz,
  question: number,
  picks: ReadonlyArray<number>,
  nowMs: number,
): WidgetQuizVerdict => {
  const stale = { kind: "stale", state: widgetQuizState(quiz.answers, false) } as const;
  const asked = quiz.questions[question];
  if (question !== quiz.answers.length || question !== quiz.current || asked === undefined) {
    return stale;
  }
  if (picks.some((index) => index >= asked.options.length)) return stale;
  const step = answerQuiz(quiz, picks, nowMs);
  if (step.kind === "ignore") return stale;
  return {
    kind: step.kind,
    quiz: step.quiz,
    state: widgetQuizState(step.quiz.answers, step.kind === "done"),
  };
};

/** The finished state of a quiz (its score went to the chat). */
export const widgetQuizDoneState = (quiz: CardQuiz): string => widgetQuizState(quiz.answers, true);

// ── Agents' own widgets ──────────────────────────────────────────────────

export interface AgentWidgetInput {
  readonly html: string;
  readonly caption?: string;
  readonly height?: number;
  readonly width?: number;
  readonly state?: string;
}

const optionalInteger = (value: unknown): number | undefined | null =>
  value === undefined || value === null
    ? undefined
    : typeof value === "number" && Number.isInteger(value)
      ? value
      : null;

/** `messenger_send` `widget`, checked; every error says how to fix the call. */
export const validateAgentWidget = (
  raw: unknown,
):
  | { readonly ok: true; readonly widget: AgentWidgetInput }
  | { readonly ok: false; readonly error: string } => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      error: 'widget must be {"html": "…"} with optional caption, height, width, state.',
    };
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.html !== "string" || record.html.trim() === "") {
    return { ok: false, error: "widget.html is required: the whole widget, inline CSS and JS." };
  }
  const html = record.html;
  const sizeProblem = widgetSizeProblem(html);
  if (sizeProblem !== null) return { ok: false, error: `widget.html: ${sizeProblem}.` };
  if (/<(input|select|textarea|iframe)\b/i.test(html)) {
    return {
      ok: false,
      error: "widget.html: Telegram drops input, select, textarea and iframe — use buttons only.",
    };
  }
  if (/<script[^>]*\ssrc=/i.test(html) || /<link\b/i.test(html)) {
    return {
      ok: false,
      error: "widget.html: no external scripts or styles (no network in a widget) — inline them.",
    };
  }
  const caption = record.caption;
  if (caption !== undefined && typeof caption !== "string") {
    return { ok: false, error: "widget.caption must be text." };
  }
  if (typeof caption === "string" && caption.length > WIDGET_CAPTION_MAX_CHARS) {
    return {
      ok: false,
      error: `widget.caption is ${caption.length} characters; at most ${WIDGET_CAPTION_MAX_CHARS}.`,
    };
  }
  const height = optionalInteger(record.height);
  if (height === null || (height !== undefined && (height < 0 || height > WIDGET_MAX_HEIGHT))) {
    return {
      ok: false,
      error: `widget.height is in px, ${WIDGET_MIN_HEIGHT}–${WIDGET_MAX_HEIGHT} (0 or none: its content's height).`,
    };
  }
  const width = optionalInteger(record.width);
  if (width === null || (width !== undefined && width < 0)) {
    return {
      ok: false,
      error: `widget.width is in px, ${WIDGET_MIN_WIDTH} or more (none: the bubble's width).`,
    };
  }
  const stateProblem = widgetStateProblem(record.state, "widget.state");
  if (stateProblem !== null) return { ok: false, error: stateProblem };
  return {
    ok: true,
    widget: {
      html,
      ...(typeof caption === "string" && caption.trim() !== "" ? { caption: caption.trim() } : {}),
      ...(height !== undefined && height > 0 ? { height } : {}),
      ...(width !== undefined && width > 0 ? { width } : {}),
      ...(typeof record.state === "string" ? { state: record.state } : {}),
    },
  };
};

/** `state` / `widget_update.state`: text of at most 1024 bytes, or why not. */
export const widgetStateProblem = (state: unknown, where: string): string | null => {
  if (state === undefined) return null;
  if (typeof state !== "string") {
    return `${where} must be text (JSON.stringify it); the widget reads it as TelegramWidget.chatData.`;
  }
  const bytes = utf8Bytes(state);
  if (bytes > WIDGET_STATE_MAX_BYTES) {
    return `${where} is ${bytes} bytes; at most ${WIDGET_STATE_MAX_BYTES} — keep only what the widget draws.`;
  }
  return null;
};

/** The first line of a caption (or the text), as the widget's name in its messages. */
export const agentWidgetTitle = (caption: string): string =>
  (caption.split("\n").find((line) => line.trim() !== "") ?? "").trim().slice(0, 80);

/** What an agent widget's request reads like in its chat. */
export const agentWidgetMessage = (widget: Pick<AgentWidget, "title">, data: string): string =>
  withHtmlRenderMessageMarker(data.trim(), { source: "widget", title: widget.title });

export const putAgentWidget = (
  state: ConnectorButtonsState,
  widget: AgentWidget,
): ConnectorButtonsState => ({
  ...state,
  widgets: [...(state.widgets ?? []), widget].slice(-200),
});

export const findAgentWidget = (
  state: ConnectorButtonsState,
  input: {
    readonly connectorProjectId: string;
    readonly chatId: string;
    readonly messageId: number;
    readonly nowMs: number;
  },
): AgentWidget | null =>
  (state.widgets ?? []).find(
    (widget) =>
      widget.connectorProjectId === input.connectorProjectId &&
      widget.chatId === input.chatId &&
      widget.messageId === input.messageId &&
      widget.expiresAtMs > input.nowMs,
  ) ?? null;

/** The last widget a chat (`threadId`) sent to this Telegram chat, alive. */
export const lastAgentWidget = (
  state: ConnectorButtonsState,
  input: {
    readonly connectorProjectId: string;
    readonly chatId: string;
    readonly threadId: string;
    readonly nowMs: number;
  },
): AgentWidget | null =>
  (state.widgets ?? [])
    .filter(
      (widget) =>
        widget.connectorProjectId === input.connectorProjectId &&
        widget.chatId === input.chatId &&
        widget.threadId === input.threadId &&
        widget.expiresAtMs > input.nowMs,
    )
    .toSorted((left, right) => right.sentAtMs - left.sentAtMs)[0] ?? null;

/** A request of an agent widget: counted, and whether it may reach the chat. */
export const admitAgentWidgetRequest = (
  state: ConnectorButtonsState,
  widget: AgentWidget,
  nowMs: number,
): { readonly state: ConnectorButtonsState; readonly admitted: boolean } => {
  const recent = (widget.requestsAtMs ?? []).filter((at) => nowMs - at < 60_000);
  if (recent.length >= AGENT_WIDGET_REQUESTS_PER_MINUTE) return { state, admitted: false };
  const next: AgentWidget = { ...widget, requestsAtMs: [...recent, nowMs] };
  return {
    state: {
      ...state,
      widgets: (state.widgets ?? []).map((entry) =>
        entry.connectorProjectId === widget.connectorProjectId &&
        entry.chatId === widget.chatId &&
        entry.messageId === widget.messageId
          ? next
          : entry,
      ),
    },
    admitted: true,
  };
};
