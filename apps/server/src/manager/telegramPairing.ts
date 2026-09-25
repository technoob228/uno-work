/**
 * Linking a Telegram chat to the assistant by a one-time code (0.0.85).
 *
 * The owner's own bot (made with @BotFather — Telegram gives every person
 * their own bot token; Uno does not run a shared bot) only answers chats on
 * its allowlist. Finding one's chat id by hand was the step nobody got past,
 * so the app issues a short-lived code and shows the bot's deep link
 * `https://t.me/<bot>?start=<code>`: pressing Start in Telegram sends
 * `/start <code>`, the daemon recognises the code, allowlists that chat and
 * points it at the assistant's main conversation. The code is only ever shown
 * inside the app, so a stranger who finds the bot cannot link themselves.
 *
 * Pure: the connector keeps the pending codes and does the I/O.
 *
 * @module manager/telegramPairing
 */
import * as crypto from "node:crypto";

/** How long a code shown in the app stays valid. */
export const TELEGRAM_PAIRING_TTL_MS = 15 * 60 * 1000;

/** A stranger writing to the bot hears the "how to link" hint at most this often. */
export const TELEGRAM_STRANGER_REPLY_INTERVAL_MS = 10 * 60 * 1000;

export interface TelegramPairing {
  readonly code: string;
  readonly expiresAtMs: number;
}

/**
 * A fresh code: `uno` + 12 hex characters. Telegram deep-link payloads allow
 * `[A-Za-z0-9_-]` up to 64 characters.
 */
export function newTelegramPairing(nowMs: number): TelegramPairing {
  return {
    code: `uno${crypto.randomBytes(6).toString("hex")}`,
    expiresAtMs: nowMs + TELEGRAM_PAIRING_TTL_MS,
  };
}

/** The payload of `/start <payload>` (or `/start@bot <payload>`), else null. */
export function parseTelegramStartPayload(text: string): string | null {
  const match = /^\/start(?:@[\w]+)?\s+([A-Za-z0-9_-]{1,64})\s*$/.exec(text.trim());
  return match?.[1] ?? null;
}

/** Whether `payload` is the pending, unexpired code. Constant-time compare. */
export function matchesTelegramPairing(
  pairing: TelegramPairing | null | undefined,
  payload: string | null,
  nowMs: number,
): boolean {
  if (!pairing || payload === null || nowMs > pairing.expiresAtMs) return false;
  const expected = Buffer.from(pairing.code, "utf8");
  const actual = Buffer.from(payload, "utf8");
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** `https://t.me/<bot>?start=<code>`, or null while the bot's name is unknown. */
export function telegramPairingLink(botUsername: string | null, code: string): string | null {
  return botUsername ? `https://t.me/${botUsername}?start=${encodeURIComponent(code)}` : null;
}

/** What the bot says in the chat it was just linked to. */
export function telegramLinkedReply(input: { readonly toMainConversation: boolean }): string {
  return input.toMainConversation
    ? "Connected. This chat now talks to Uno, your assistant: the same conversation you see pinned in Uno Work. Write here any time."
    : "Connected. This chat now talks to Uno, your assistant. Write here any time.";
}

/**
 * What the bot says to a private chat that is not linked (a stranger, or the
 * owner before linking): how to link, plus the chat id for the manual path.
 */
export function telegramStrangerReply(chatId: string): string {
  return [
    "This bot belongs to an Uno Work computer and only talks to chats linked to it.",
    "If it's yours: open Uno Work, then Uno, then Connect Telegram, and press Start on the link shown there.",
    `Chat id: ${chatId}`,
  ].join("\n");
}

/** Whether a stranger should hear the hint again (at most once per interval per chat). */
export function shouldReplyToStranger(lastRepliedAtMs: number | undefined, nowMs: number): boolean {
  return (
    lastRepliedAtMs === undefined || nowMs - lastRepliedAtMs >= TELEGRAM_STRANGER_REPLY_INTERVAL_MS
  );
}
