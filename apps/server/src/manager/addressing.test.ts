import { describe, expect, it } from "@effect/vitest";

import {
  DEFAULT_ADDRESSING_CONFIG,
  decideAddressing,
  nameIsMentioned,
  type AddressingConfig,
  type NormalizedIncomingMessage,
} from "./addressing.ts";

const message = (
  overrides: Partial<NormalizedIncomingMessage>,
): NormalizedIncomingMessage => ({
  isDirectMessage: false,
  isReplyToBot: false,
  explicitMention: false,
  senderIsBot: false,
  text: "",
  ...overrides,
});

const config = (overrides: Partial<AddressingConfig> = {}): AddressingConfig => ({
  ...DEFAULT_ADDRESSING_CONFIG,
  ...overrides,
});

describe("nameIsMentioned", () => {
  it("matches an exact configured name regardless of case and punctuation", () => {
    expect(nameIsMentioned("Антоха, посмотри", ["Антоха"])).toBe(true);
    expect(nameIsMentioned("эй антоха!", ["Антоха"])).toBe(true);
  });

  it("matches nickname drift and declensions the owner did not spell out", () => {
    // Configured "Антоха"; people actually say "Антон"/"Антону".
    expect(nameIsMentioned("Антон, глянь плз", ["Антоха"])).toBe(true);
    expect(nameIsMentioned("передай Антону", ["Антоха"])).toBe(true);
    // Configured stem "Тоха" caught in a declined form.
    expect(nameIsMentioned("спроси у Тохи", ["Тоха"])).toBe(true);
  });

  it("folds ё→е", () => {
    expect(nameIsMentioned("Лёша сделай", ["Леша"])).toBe(true);
  });

  it("does not fire on unrelated words that merely share a short prefix", () => {
    expect(nameIsMentioned("антарктида далеко", ["Антоха"])).toBe(false);
    expect(nameIsMentioned("ты где", ["Тоха"])).toBe(false);
    expect(nameIsMentioned("это точно так", ["Тоха"])).toBe(false);
  });

  it("is empty-safe", () => {
    expect(nameIsMentioned("", ["Антоха"])).toBe(false);
    expect(nameIsMentioned("что-то", [])).toBe(false);
    expect(nameIsMentioned("что-то", ["  "])).toBe(false);
  });
});

describe("decideAddressing", () => {
  it("always answers a direct message", () => {
    expect(decideAddressing(message({ isDirectMessage: true }), config())).toEqual({
      addressed: true,
      reason: "direct",
    });
  });

  it("never answers another bot, even in a DM", () => {
    expect(
      decideAddressing(
        message({ isDirectMessage: true, senderIsBot: true }),
        config(),
      ),
    ).toEqual({ addressed: false, needsSmartCheck: false });
  });

  it("stays silent in a group for an unaddressed message", () => {
    expect(decideAddressing(message({ text: "погода супер" }), config())).toEqual({
      addressed: false,
      needsSmartCheck: false,
    });
  });

  it("answers a group message that replies to the bot", () => {
    expect(decideAddressing(message({ isReplyToBot: true }), config())).toEqual({
      addressed: true,
      reason: "reply",
    });
  });

  it("answers an explicit @mention", () => {
    expect(decideAddressing(message({ explicitMention: true }), config())).toEqual({
      addressed: true,
      reason: "mention",
    });
  });

  it("answers when called by name in a group", () => {
    expect(
      decideAddressing(
        message({ text: "Антон, посмотри логи" }),
        config({ names: ["Антоха"] }),
      ),
    ).toEqual({ addressed: true, reason: "name" });
  });

  it("answers everything when the group is marked always-on", () => {
    expect(
      decideAddressing(
        message({ text: "просто болтаем" }),
        config({ requireMentionInGroups: false }),
      ),
    ).toEqual({ addressed: true, reason: "open-group" });
  });

  it("uses the hot window only when enabled and active", () => {
    const hot = config({ hotWindowSec: 60 });
    expect(
      decideAddressing(message({ text: "и ещё вопрос" }), hot, {
        withinHotWindow: true,
      }),
    ).toEqual({ addressed: true, reason: "hot-window" });
    // Disabled hot window ignores the flag.
    expect(
      decideAddressing(message({ text: "и ещё вопрос" }), config(), {
        withinHotWindow: true,
      }),
    ).toEqual({ addressed: false, needsSmartCheck: false });
  });

  it("flags a smart check only when smartWake is on and there is text", () => {
    expect(
      decideAddressing(message({ text: "глянь плиз кто-нибудь" }), config({ smartWake: true })),
    ).toEqual({ addressed: false, needsSmartCheck: true });
    // No text (e.g. a caption-less photo) — nothing for the classifier to read.
    expect(
      decideAddressing(message({ text: "   " }), config({ smartWake: true })),
    ).toEqual({ addressed: false, needsSmartCheck: false });
  });

  it("prefers a deterministic hit over the smart tier", () => {
    expect(
      decideAddressing(
        message({ text: "Антоха помоги", explicitMention: true }),
        config({ names: ["Антоха"], smartWake: true }),
      ),
    ).toEqual({ addressed: true, reason: "mention" });
  });
});
