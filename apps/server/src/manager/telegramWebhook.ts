/**
 * A person's own Telegram bot on a computer that sleeps (economy mode).
 *
 * Long polling only works while the daemon runs: a sleeping computer hears
 * nothing, and the bot stays silent until somebody opens Uno Work. A sleeping
 * computer does wake when its own address is requested (wake-on-request: the
 * node's edge holds the request, wakes the machine and passes it on — the
 * same wake `/run` uses, reached over HTTP). So on an economy computer the
 * daemon asks Telegram to DELIVER updates to that address (a webhook) instead
 * of waiting to be asked: the message itself wakes the computer.
 *
 * The bot token never leaves the computer: the webhook address carries an id
 * derived from the token, Telegram proves itself with a secret derived from
 * the token (`X-Telegram-Bot-Api-Secret-Token`), and nothing about the bot is
 * stored in the console.
 *
 * Telegram refuses `getUpdates` while a webhook is set (HTTP 409). A daemon
 * that only polls — the previous version, the one a computer is rolled back
 * to — recognises a webhook Uno Work itself set and removes it. What "our own
 * webhook" means is therefore a contract between versions and must not
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

import { isRelayCredential, isRouteCredential } from "./channelRelay.ts";

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

// ── Webhook mode (economy computers) ─────────────────────────────────────

/** The header Telegram repeats the webhook's `secret_token` in. */
export const TELEGRAM_WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/** While the webhook is fine, look at it this often (and right after a wake). */
export const WEBHOOK_CHECK_INTERVAL_MS = 60_000;
/** A delivery error older than this no longer says anything about now. */
export const WEBHOOK_ERROR_FRESH_MS = 15 * 60_000;

/** The `secret_token` Telegram must send back with every update. */
export const telegramWebhookSecret = (botToken: string): string => derive(botToken, "secret");

export const telegramWebhookUrl = (publicUrl: string, botToken: string): string =>
  `${publicUrl.replace(/\/+$/, "")}${TELEGRAM_WEBHOOK_PATH_PREFIX}${telegramWebhookHookId(botToken)}`;

/** Constant-time check of the secret header against this bot's secret. */
export const isTelegramWebhookSecretValid = (
  botToken: string,
  presented: string | null | undefined,
): boolean => {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const expected = Buffer.from(telegramWebhookSecret(botToken));
  const given = Buffer.from(presented);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

/** What the daemon knows about reaching this computer from outside. */
export interface MachineIngress {
  /** `https://<computer>-<label>.app.uno4.dev`; null when it has no web address. */
  readonly publicUrl: string | null;
  /** Economy mode is on: the computer sleeps when idle. */
  readonly economy: boolean;
  /** A request to the address wakes the sleeping computer. */
  readonly wakeOnHttp: boolean;
}

/** `GET /api/v1/boxes/{id}` → what matters here; null for a malformed answer. */
export function parseMachineIngress(body: unknown): MachineIngress | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const url = typeof record["url"] === "string" ? record["url"].trim() : "";
  const economy = record["economy"];
  return {
    publicUrl: /^https:\/\/[^/\s]+$/.test(url.replace(/\/+$/, "")) ? url.replace(/\/+$/, "") : null,
    economy:
      typeof economy === "object" &&
      economy !== null &&
      (economy as Record<string, unknown>)["enabled"] === true,
    wakeOnHttp: record["wake_on_http"] === true,
  };
}

export type TelegramIngress =
  | { readonly mode: "poll" }
  | { readonly mode: "webhook"; readonly url: string };

/**
 * Long polling or a webhook for this bot, right now.
 *
 * A webhook only where polling cannot do the job: the person's OWN bot (Uno's
 * shared bot already wakes the computer through the console's relay) on an
 * Uno computer in economy mode whose address wakes it. Everywhere else — an
 * always-on computer, a laptop, a server of one's own — nothing changes.
 */
export function decideTelegramIngress(input: {
  readonly botToken: string;
  readonly machine: MachineIngress | null;
}): TelegramIngress {
  if (isRelayCredential(input.botToken) || isRouteCredential(input.botToken)) {
    return { mode: "poll" };
  }
  const machine = input.machine;
  if (machine === null || !machine.economy || !machine.wakeOnHttp || machine.publicUrl === null) {
    return { mode: "poll" };
  }
  return { mode: "webhook", url: telegramWebhookUrl(machine.publicUrl, input.botToken) };
}

export type WebhookUpkeep =
  /** Telegram delivers to us; nothing to do. */
  | "ok"
  /** No webhook, or ours on another address: point it here. */
  | "set"
  /**
   * Telegram holds updates it failed to deliver (the wake took too long, the
   * address was down): fetch them ourselves now, then set the webhook again.
   */
  | "drain"
  /** The bot's webhook points at somebody else's service: leave it alone. */
  | "foreign";

export function decideWebhookUpkeep(input: {
  readonly info: TelegramWebhookInfo;
  readonly desiredUrl: string;
  readonly botToken: string;
  readonly nowMs: number;
  /** When this process last fetched the held updates itself (0 — never). */
  readonly lastDrainAtMs: number;
}): WebhookUpkeep {
  const current = (input.info.url ?? "").trim();
  if (current.length > 0 && !isOwnTelegramWebhook(current, input.botToken)) return "foreign";
  const pending = input.info.pending_update_count ?? 0;
  const lastErrorMs = (input.info.last_error_date ?? 0) * 1000;
  const failedLately =
    lastErrorMs > 0 &&
    lastErrorMs > input.lastDrainAtMs &&
    input.nowMs - lastErrorMs <= WEBHOOK_ERROR_FRESH_MS;
  if (pending > 0 && failedLately) return "drain";
  return current === input.desiredUrl ? "ok" : "set";
}
