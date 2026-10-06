/**
 * The free bot before payment (fishcode feat/free-bot-days): Uno AI writes the
 * bot's settings in the chat (bot_setup), the person makes the bot in
 * @BotFather and pastes its token on the card — the account starts the bot,
 * free for a few days; "Keep it on" is the plan.
 *
 *   GET  /api/v1/free-bot        — the status (wakes nothing, cheap)
 *   POST /api/v1/free-bot/token  — { token } → 202 + the status ("starting")
 *
 * The token goes only to that POST: never into the chat, storage or logs.
 * Everything below except the two calls is pure and unit-tested.
 */
import { accountRequest } from "../account/unoAccount";
import type { BotState } from "./unoAiModel";

export interface FreeBotStatus {
  readonly enabled: boolean;
  readonly days: number;
  readonly reason?: string;
  readonly state: BotState;
  readonly error?: string;
  readonly on_free_days: boolean;
  readonly free_until?: string;
  readonly bot?: {
    readonly username: string;
    readonly url: string;
    readonly owner_url?: string;
    readonly app_server_id?: number | string;
    readonly server_state?: string;
    readonly messages_answered: number;
  };
  readonly spec?: Record<string, unknown>;
  readonly keep_on?: {
    readonly plan: string;
    readonly name: string;
    readonly price_usd: number;
    readonly checkout_url: string;
  };
}

export const freeBotKey = ["workspace", "unoAi", "freeBot"] as const;

/** While the bot starts — every 3 s; otherwise at most every 30 s while it's on screen. */
export const FREE_BOT_POLL_STARTING_MS = 3_000;
export const FREE_BOT_POLL_IDLE_MS = 30_000;

export function freeBotPollMs(state: BotState | undefined): number {
  return state === "starting" ? FREE_BOT_POLL_STARTING_MS : FREE_BOT_POLL_IDLE_MS;
}

export async function fetchFreeBot(): Promise<FreeBotStatus> {
  return (await accountRequest("GET", "/api/v1/free-bot")) as FreeBotStatus;
}

export async function submitFreeBotToken(token: string): Promise<FreeBotStatus> {
  return (await accountRequest("POST", "/api/v1/free-bot/token", { token })) as FreeBotStatus;
}

/** A bot token from BotFather: digits, a colon, ~35 characters. */
const TOKEN = /\b\d{5,}:[A-Za-z0-9_-]{30,}\b/;

/**
 * What to send: the token itself, also when the person pasted BotFather's
 * whole message ("Use this token to access the HTTP API: 123:ABC… Keep your
 * token secure…").
 */
export function extractBotToken(text: string): string {
  const match = TOKEN.exec(text);
  return match ? match[0] : text.trim();
}

/** The chat box got a bot token — it must not go to the chat. */
export function looksLikeBotToken(text: string): boolean {
  return TOKEN.test(text);
}

/** "Oct 12" in the person's locale; the transcript may already have it as text. */
export function formatFreeUntil(value: string | null | undefined, locale?: string): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t) || !/\d{4}-\d{2}-\d{2}/.test(value)) return value;
  return new Date(t).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

export function priceLabel(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

/** "Keep it on — $20/mo" (or just "Keep it on" when the price isn't known). */
export function keepOnLabel(keepOn: FreeBotStatus["keep_on"] | undefined): string {
  return keepOn && Number.isFinite(keepOn.price_usd) && keepOn.price_usd > 0
    ? `Keep it on — ${priceLabel(keepOn.price_usd)}/mo`
    : "Keep it on";
}

export function answeredLabel(n: number, capital: boolean): string {
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return `${capital ? "Answered" : "answered"} ${count} ${count === 1 ? "message" : "messages"}`;
}

/** Under a live bot: "Free until Oct 12 · answered 37 messages" / "Answered 37 messages". */
export function liveMetaLine(status: FreeBotStatus, locale?: string): string {
  const answered = status.bot?.messages_answered ?? 0;
  const until = status.on_free_days ? formatFreeUntil(status.free_until, locale) : null;
  return until
    ? `Free until ${until} · ${answeredLabel(answered, false)}`
    : answeredLabel(answered, true);
}

/** The free bot in lite's sidebar ("Live"): "@crumb_bot · free until Oct 12 · answered 37". */
export function liveTileLine(status: FreeBotStatus, locale?: string): string | null {
  const username = status.bot?.username;
  if (!username) return null;
  const parts = [`@${username}`];
  if (status.state === "starting") parts.push("starting");
  else if (status.state === "ended") parts.push("asleep");
  else if (status.on_free_days) {
    const until = formatFreeUntil(status.free_until, locale);
    if (until) parts.push(`free until ${until}`);
  }
  if (status.state !== "starting") parts.push(`answered ${status.bot?.messages_answered ?? 0}`);
  return parts.join(" · ");
}

/** Errors of the token POST that mean "the free days aren't there — keep it on with a plan". */
export function tokenErrorOffersPlan(code: string): boolean {
  return code === "FREE_BOT_FULL" || code === "FREE_BOT_USED" || code === "FREE_BOT_ENDED";
}
