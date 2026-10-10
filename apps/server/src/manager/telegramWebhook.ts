/**
 * Uno Work's own Telegram webhook, as far as a long-polling daemon has to
 * know about it.
 *
 * A later version of Uno Work lets Telegram deliver a person's own bot's
 * messages to the computer's address (a webhook) instead of long-polling, so
 * a message wakes a sleeping computer. Telegram refuses `getUpdates` while a
 * webhook is set (HTTP 409). A daemon that only polls — this version, or the
 * one a computer is rolled back to — must therefore recognise a webhook Uno
 * Work itself set and remove it, or the bot would stay silent for good.
 *
 * What "our own webhook" means is a contract between versions and must not
 * drift: an https address whose path is {@link TELEGRAM_WEBHOOK_PATH_PREFIX}
 * followed by {@link telegramWebhookHookId} of this very bot token. The host
 * is deliberately not part of it — a computer's address can change, and the
 * id (an HMAC of the token) is something only Uno Work holding this token
 * produces, so a person's own service on a look-alike path is never mistaken
 * for ours.
 *
 * Everything here is pure; `Layers/TelegramConnector.ts` does the calls.
 *
 * @module manager/telegramWebhook
 */
import * as crypto from "node:crypto";

/** Where Telegram posts updates on a computer's own address. */
export const TELEGRAM_WEBHOOK_PATH_PREFIX = "/api/telegram/webhook/";

const derive = (botToken: string, label: string): string =>
  crypto.createHmac("sha256", botToken).update(`uno-work:telegram-webhook:${label}`).digest("hex");

/**
 * The id in the webhook path. Derived from the token, so it is the same after
 * a restart or on a restored copy of the computer, changes with the bot, and
 * gives nothing away about the token.
 */
export const telegramWebhookHookId = (botToken: string): string =>
  derive(botToken, "id").slice(0, 32);

/**
 * Whether a webhook address is one this bot's Uno Work connection set (on
 * this computer's address, a previous one, or a copy of the computer). A
 * webhook somebody pointed elsewhere is not ours to move or remove.
 */
export const isOwnTelegramWebhook = (url: string | null | undefined, botToken: string): boolean =>
  typeof url === "string" &&
  url.startsWith("https://") &&
  url.endsWith(`${TELEGRAM_WEBHOOK_PATH_PREFIX}${telegramWebhookHookId(botToken)}`);

/** The fields of Telegram's `getWebhookInfo` Uno Work reads. */
export interface TelegramWebhookInfo {
  readonly url?: string;
  readonly pending_update_count?: number;
  /** Unix seconds of the last failed delivery. */
  readonly last_error_date?: number;
  readonly last_error_message?: string;
}

/** `getUpdates` refused because a webhook is set (HTTP 409). */
export const isWebhookConflict = (errorCode: number | undefined, description: string | undefined) =>
  errorCode === 409 && /webhook/i.test(description ?? "");

/**
 * Shown as the connector's error when the bot's webhook belongs to another
 * service: Uno Work leaves it alone, and the bot cannot be read here until
 * the person removes it.
 */
export const FOREIGN_TELEGRAM_WEBHOOK_MESSAGE =
  "This bot already sends its messages to another service (a webhook is set there). Remove that webhook or connect a different bot.";
