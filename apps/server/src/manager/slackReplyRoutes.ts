/**
 * Replies to a chat's Slack message go back to that chat — Slack's half of
 * Telegram's `routeReplies` (connectorButtons.ts `SentMessageRoute`).
 *
 * A chat other than the assistant writes to the person (`messenger_send`,
 * `show_card` there): the message is headed with the chat's name. In
 * Telegram the person answers with "Reply" on it; in Slack they answer in
 * the message's thread. The sent message's `ts` maps to the chat; a thread
 * reply under it is that chat's message, not the assistant's.
 *
 * Slack gets a choice's buttons as numbered options: "2" or the option's
 * label in the thread stands for pressing it, and the chat gets the button's
 * value, as a Telegram press sends it. Allow / Decline of an approval are
 * real Slack buttons (slackButtons.ts, 23.11).
 *
 * Plain values: the connector keeps the state in a Ref and on disk
 * (`slack-reply-routes.json`), so a daemon update keeps them working.
 *
 * @module manager/slackReplyRoutes
 */
import { REPLY_ROUTE_TTL_MS, type ConnectorButton } from "./connectorButtons.ts";
import type { ReplyLanguage } from "./connectorReplyText.ts";

/** One option shown as a numbered line: the label, and what a pick sends. */
export interface SlackReplyOption {
  readonly label: string;
  readonly value: string;
}

export interface SlackReplyRoute {
  readonly connectorProjectId: string;
  readonly channel: string;
  /** The `ts` of the message the chat sent: its thread is the reply. */
  readonly ts: string;
  readonly threadId: string;
  readonly options: ReadonlyArray<SlackReplyOption>;
  readonly atMs: number;
}

export interface SlackReplyRoutesState {
  readonly routes: ReadonlyArray<SlackReplyRoute>;
}

export const EMPTY_SLACK_REPLY_ROUTES: SlackReplyRoutesState = { routes: [] };

const MAX_SLACK_ROUTES = 2_000;

export const pruneSlackReplyRoutes = (
  state: SlackReplyRoutesState,
  nowMs: number,
): SlackReplyRoutesState => ({
  routes: state.routes
    .filter((route) => nowMs - route.atMs < REPLY_ROUTE_TTL_MS)
    .slice(-MAX_SLACK_ROUTES),
});

export const addSlackReplyRoute = (
  state: SlackReplyRoutesState,
  route: SlackReplyRoute,
  nowMs: number,
): SlackReplyRoutesState => {
  const pruned = pruneSlackReplyRoutes(state, nowMs);
  return {
    routes: [
      ...pruned.routes.filter(
        (known) =>
          !(
            known.connectorProjectId === route.connectorProjectId &&
            known.channel === route.channel &&
            known.ts === route.ts
          ),
      ),
      route,
    ].slice(-MAX_SLACK_ROUTES),
  };
};

/** The route of a reply in the thread of `threadTs`, or null. */
export const findSlackReplyRoute = (
  state: SlackReplyRoutesState,
  input: {
    readonly connectorProjectId: string;
    readonly channel: string;
    readonly threadTs: string;
    readonly nowMs: number;
  },
): SlackReplyRoute | null =>
  state.routes.find(
    (route) =>
      route.connectorProjectId === input.connectorProjectId &&
      route.channel === input.channel &&
      route.ts === input.threadTs &&
      input.nowMs - route.atMs < REPLY_ROUTE_TTL_MS,
  ) ?? null;

const normalizeOption = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s.!)]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();

/**
 * What a reply in the thread stands for: "2", "2.", "#2" or an option's
 * label picks that option (its value); anything else is the text itself.
 */
export const resolveSlackOptionReply = (
  text: string,
  options: ReadonlyArray<SlackReplyOption>,
): { readonly text: string; readonly picked: SlackReplyOption | null } => {
  const trimmed = text.trim();
  if (options.length === 0) return { text: trimmed, picked: null };
  const number = /^#?(\d{1,2})[.)]?$/u.exec(trimmed);
  if (number !== null) {
    const option = options[Number(number[1]) - 1];
    if (option !== undefined) return { text: option.value, picked: option };
  }
  const wanted = normalizeOption(trimmed);
  const byLabel = options.find((option) => normalizeOption(option.label) === wanted);
  return byLabel !== undefined
    ? { text: byLabel.value, picked: byLabel }
    : { text: trimmed, picked: null };
};

/**
 * The buttons Slack can stand in for: those whose press sends a value
 * (approvals stay in Uno Work; toggles send their value, one at a time).
 */
export const slackReplyOptions = (
  rows: ReadonlyArray<ReadonlyArray<ConnectorButton>>,
): ReadonlyArray<SlackReplyOption> =>
  rows
    .flat()
    .flatMap((button) =>
      button.action.kind === "reply" || button.action.kind === "toggle"
        ? [{ label: button.label, value: button.action.value }]
        : [],
    );

/** Buttons in Slack: numbered, answered by a number in the thread. */
export const slackOptionsText = (
  options: ReadonlyArray<SlackReplyOption>,
  language: ReplyLanguage,
): string => {
  const list = options.map((option, index) => `${index + 1}. ${option.label}`).join("\n");
  return `${list}\n${slackNumberHint(language)}`;
};

/** How to pick a numbered option in Slack. */
export const slackNumberHint = (language: ReplyLanguage): string =>
  language === "ru"
    ? "_Ответьте в ветке номером варианта._"
    : "_Reply in the thread with a number._";

/** Under a chat's message without options: where the answer goes. */
export const slackReplyHint = (language: ReplyLanguage): string =>
  language === "ru"
    ? "_Ответ в ветке уйдёт в этот чат._"
    : "_Reply in the thread to answer this chat._";

/** Drop malformed entries of a state read from disk. */
export const decodeSlackReplyRoutes = (raw: unknown): SlackReplyRoutesState => {
  if (typeof raw !== "object" || raw === null) return EMPTY_SLACK_REPLY_ROUTES;
  const routes = (raw as { readonly routes?: unknown }).routes;
  if (!Array.isArray(routes)) return EMPTY_SLACK_REPLY_ROUTES;
  return {
    routes: routes.filter(
      (route): route is SlackReplyRoute =>
        typeof route === "object" &&
        route !== null &&
        typeof route.connectorProjectId === "string" &&
        typeof route.channel === "string" &&
        typeof route.ts === "string" &&
        typeof route.threadId === "string" &&
        typeof route.atMs === "number" &&
        Array.isArray(route.options) &&
        route.options.every(
          (option: unknown) =>
            typeof option === "object" &&
            option !== null &&
            typeof (option as SlackReplyOption).label === "string" &&
            typeof (option as SlackReplyOption).value === "string",
        ),
    ),
  };
};
