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

/** Languages the assistant's first hello is written in (else English). */
const OWN_BOT_HELLO: Readonly<
  Record<
    string,
    { readonly hello: (name: string) => string; readonly same: string; readonly example: string }
  >
> = {
  en: {
    hello: (name) => `Hi, it's ${name}, your assistant.`,
    same: "This is the same conversation you see pinned in Uno Work: write here any time,",
    example: "for example “Every morning at 8, send me a plan for the day”.",
  },
  ru: {
    hello: (name) => `Привет, это ${name}, твой ассистент.`,
    same: "Это тот же разговор, что закреплён в Uno Work: пиши сюда когда угодно,",
    example: "например «Каждое утро в 8 присылай план на день».",
  },
  uk: {
    hello: (name) => `Привіт, це ${name}, твій асистент.`,
    same: "Це та сама розмова, що закріплена в Uno Work: пиши сюди будь-коли,",
    example: "наприклад «Щоранку о 8 надсилай план на день».",
  },
  es: {
    hello: (name) => `Hola, soy ${name}, tu asistente.`,
    same: "Es la misma conversación que ves fijada en Uno Work: escríbeme aquí cuando quieras,",
    example: "por ejemplo «Cada mañana a las 8, mándame un plan del día».",
  },
  pt: {
    hello: (name) => `Olá, é ${name}, seu assistente.`,
    same: "Esta é a mesma conversa fixada no Uno Work: escreva aqui quando quiser,",
    example: "por exemplo “Toda manhã às 8, me mande um plano do dia”.",
  },
  de: {
    hello: (name) => `Hallo, hier ist ${name}, dein Assistent.`,
    same: "Das ist dasselbe Gespräch, das in Uno Work angeheftet ist: schreib hier jederzeit,",
    example: "zum Beispiel „Schick mir jeden Morgen um 8 einen Plan für den Tag“.",
  },
  fr: {
    hello: (name) => `Bonjour, c'est ${name}, votre assistant.`,
    same: "C'est la même conversation que celle épinglée dans Uno Work : écrivez ici quand vous voulez,",
    example: "par exemple « Chaque matin à 8 h, envoie-moi le plan de la journée ».",
  },
  it: {
    hello: (name) => `Ciao, sono ${name}, il tuo assistente.`,
    same: "È la stessa conversazione fissata in Uno Work: scrivimi qui quando vuoi,",
    example: "per esempio «Ogni mattina alle 8 mandami il piano della giornata».",
  },
};

/** `language_code` of Telegram ("ru", "pt-br") → a language we have, else "en". */
export function helloLanguage(languageCode: string | null | undefined): string {
  const base = (languageCode ?? "").toLowerCase().split(/[-_]/)[0] ?? "";
  return base in OWN_BOT_HELLO ? base : "en";
}

/**
 * What the bot says in the chat it was just linked to.
 *
 * - Its own bot (the default since 05.10: the person made it in @BotFather):
 *   the assistant's hello, by its name, in the person's Telegram language —
 *   it is the first message of that bot, nothing came before it.
 * - Uno's shared bot (older setups): the console has already said "Linked to
 *   your Uno computer. It will answer here in a moment." (fishcode A-04), so
 *   the computer's own line is that answer — a hello, not a second
 *   "Connected" (two in a row, 05.10.2026).
 */
export function telegramLinkedReply(input: {
  readonly toMainConversation: boolean;
  readonly viaSharedBot?: boolean;
  /** The assistant's name (its pinned chat's title); "Uno" when unknown. */
  readonly name?: string | null;
  /** The person's Telegram `language_code`. */
  readonly languageCode?: string | null;
}): string {
  if (input.viaSharedBot) {
    return input.toMainConversation
      ? "Hi, it's Uno, your assistant. This is the same conversation you see pinned in Uno Work: write here any time, for example “Every morning at 8, send me a plan for the day”."
      : "Hi, it's Uno, your assistant. Write here any time, for example “Every morning at 8, send me a plan for the day”.";
  }
  const copy = OWN_BOT_HELLO[helloLanguage(input.languageCode)]!;
  const name = input.name?.trim() || "Uno";
  if (input.toMainConversation) {
    return `${copy.hello(name)} ${copy.same} ${copy.example}`;
  }
  // No pinned conversation behind it: just "write here any time".
  const anyTime = copy.same.slice(copy.same.lastIndexOf(":") + 1).trim();
  return `${copy.hello(name)} ${anyTime.charAt(0).toUpperCase()}${anyTime.slice(1)} ${copy.example}`;
}

/**
 * The reply when the chat was linked to another assistant of this computer
 * that talks through the same bot (Uno's shared bot): the chat now talks to
 * it, and `/assistant` switches.
 */
export function telegramRoutedLinkedReply(input: { readonly name: string | null }): string {
  const name = input.name?.trim() || "your assistant";
  return `This chat now talks to ${name}. Several assistants of your computer share this bot: send /assistant <name> to talk to another one.`;
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
