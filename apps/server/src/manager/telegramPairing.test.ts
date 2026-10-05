import { describe, expect, it } from "vitest";

import {
  matchesTelegramPairing,
  newTelegramPairing,
  parseTelegramStartPayload,
  shouldReplyToStranger,
  TELEGRAM_PAIRING_TTL_MS,
  TELEGRAM_STRANGER_REPLY_INTERVAL_MS,
  helloLanguage,
  telegramLinkedReply,
  telegramPairingLink,
  telegramRoutedLinkedReply,
  telegramStrangerReply,
} from "./telegramPairing.ts";

describe("telegramPairing", () => {
  it("issues a deep-link-safe code that expires", () => {
    const pairing = newTelegramPairing(1_000);
    expect(pairing.code).toMatch(/^uno[0-9a-f]{12}$/);
    expect(pairing.expiresAtMs).toBe(1_000 + TELEGRAM_PAIRING_TTL_MS);
    expect(newTelegramPairing(1_000).code).not.toBe(pairing.code);
  });

  it("reads the payload of /start, with or without the bot's name", () => {
    expect(parseTelegramStartPayload("/start uno0123456789ab")).toBe("uno0123456789ab");
    expect(parseTelegramStartPayload("/start@my_bot uno0123456789ab ")).toBe("uno0123456789ab");
    expect(parseTelegramStartPayload("/start")).toBeNull();
    expect(parseTelegramStartPayload("hello /start uno1")).toBeNull();
    expect(parseTelegramStartPayload("/start two words")).toBeNull();
  });

  it("matches only the pending, unexpired code", () => {
    const pairing = { code: "uno0123456789ab", expiresAtMs: 5_000 };
    expect(matchesTelegramPairing(pairing, "uno0123456789ab", 4_999)).toBe(true);
    expect(matchesTelegramPairing(pairing, "uno0123456789ab", 5_001)).toBe(false);
    expect(matchesTelegramPairing(pairing, "uno0123456789ac", 1_000)).toBe(false);
    expect(matchesTelegramPairing(pairing, "uno", 1_000)).toBe(false);
    expect(matchesTelegramPairing(null, "uno0123456789ab", 1_000)).toBe(false);
    expect(matchesTelegramPairing(pairing, null, 1_000)).toBe(false);
  });

  it("builds the bot link once the bot's name is known", () => {
    expect(telegramPairingLink("uno_misha_bot", "uno01")).toBe(
      "https://t.me/uno_misha_bot?start=uno01",
    );
    expect(telegramPairingLink(null, "uno01")).toBeNull();
  });

  it("tells a not-linked chat how to link, at most every few minutes", () => {
    expect(telegramStrangerReply("128841517")).toContain("Chat id: 128841517");
    expect(shouldReplyToStranger(undefined, 10)).toBe(true);
    expect(shouldReplyToStranger(0, TELEGRAM_STRANGER_REPLY_INTERVAL_MS - 1)).toBe(false);
    expect(shouldReplyToStranger(0, TELEGRAM_STRANGER_REPLY_INTERVAL_MS)).toBe(true);
  });
});

describe("linked replies", () => {
  it("own bot: the assistant says hello by its name, in the person's language", () => {
    expect(telegramLinkedReply({ toMainConversation: true, name: "Nova" })).toBe(
      "Hi, it's Nova, your assistant. This is the same conversation you see pinned in Uno Work: write here any time, for example “Every morning at 8, send me a plan for the day”.",
    );
    expect(
      telegramLinkedReply({ toMainConversation: true, name: "Nova", languageCode: "ru" }),
    ).toBe(
      "Привет, это Nova, твой ассистент. Это тот же разговор, что закреплён в Uno Work: пиши сюда когда угодно, например «Каждое утро в 8 присылай план на день».",
    );
    expect(telegramLinkedReply({ toMainConversation: false, languageCode: "pt-br" })).toBe(
      "Olá, é Uno, seu assistente. Escreva aqui quando quiser, por exemplo “Toda manhã às 8, me mande um plano do dia”.",
    );
    expect(helloLanguage("zh-hans")).toBe("en");
    expect(helloLanguage(undefined)).toBe("en");
    for (const languageCode of ["en", "ru", "uk", "es", "pt", "de", "fr", "it"]) {
      expect(
        telegramLinkedReply({ toMainConversation: true, name: "Nova", languageCode }),
      ).not.toMatch(/Connected|Linked/);
    }
  });

  it("Uno's shared bot: the console already said Linked, so a hello, not a second Connected", () => {
    for (const toMainConversation of [true, false]) {
      const text = telegramLinkedReply({ toMainConversation, viaSharedBot: true });
      expect(text).toMatch(/^Hi, it's Uno, your assistant\./);
      expect(text).not.toMatch(/Connected|Linked/);
    }
    expect(telegramRoutedLinkedReply({ name: "Nova" })).toMatch(/^This chat now talks to Nova\./);
  });
});
