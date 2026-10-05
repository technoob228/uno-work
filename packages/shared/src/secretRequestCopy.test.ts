import { describe, expect, it } from "vitest";

import {
  isTelegramBotTokenName,
  lateSecretMessage,
  parseUnoWorkNote,
  secretHelp,
} from "./secretRequestCopy.ts";

describe("secretHelp", () => {
  it("points a Telegram bot token at @BotFather", () => {
    for (const name of ["TELEGRAM_BOT_TOKEN", "TG_TOKEN", "BOT_TELEGRAM_TOKEN"]) {
      expect(isTelegramBotTokenName(name)).toBe(true);
      expect(secretHelp(name)?.url).toBe("https://t.me/BotFather");
    }
  });

  it("knows nothing about other secrets", () => {
    expect(secretHelp("OPENAI_API_KEY")).toBeNull();
    expect(secretHelp("TELEGRAM_CHAT_ID")).toBeNull();
    expect(isTelegramBotTokenName("TGIF_TOKEN")).toBe(false);
  });
});

describe("parseUnoWorkNote", () => {
  it("reads the late answers the computer sends to the agent, in the person's words", () => {
    const saved = parseUnoWorkNote(
      lateSecretMessage({
        name: "TELEGRAM_BOT_TOKEN",
        cwd: "/home/unowork/projects/bot",
        outcome: { ok: true, file: ".env" },
      }),
    );
    expect(saved).toEqual({
      kind: "secret-saved",
      name: "TELEGRAM_BOT_TOKEN",
      text: "You saved the Telegram bot token. It stays on your computer, not in the chat.",
    });
    const declined = parseUnoWorkNote(
      lateSecretMessage({
        name: "TELEGRAM_BOT_TOKEN",
        cwd: "/p",
        outcome: { ok: false, error: "The user declined to provide this secret." },
      }),
    );
    expect(declined?.kind).toBe("secret-declined");
    expect(declined?.text).not.toContain("/home");
    expect(declined?.text).not.toContain("TELEGRAM_BOT_TOKEN");
  });

  it("leaves what people write alone", () => {
    expect(parseUnoWorkNote("Make me a bot")).toBeNull();
    expect(parseUnoWorkNote("(Uno Work is great)")).toBeNull();
  });

  it("hides any other computer note behind a neutral line", () => {
    expect(parseUnoWorkNote("(Uno Work) Something new.")?.kind).toBe("other");
  });
});
