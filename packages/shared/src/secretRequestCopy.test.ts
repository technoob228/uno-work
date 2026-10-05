import { describe, expect, it } from "vitest";

import {
  ASSISTANT_BOT_TOKEN_NAME,
  humanSecretLabel,
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

describe("the assistant's own bot", () => {
  it("asks in three short steps with Open @BotFather", () => {
    const help = secretHelp(ASSISTANT_BOT_TOKEN_NAME);
    expect(help?.label).toBe("Open @BotFather");
    expect(help?.steps).toEqual(["Send /newbot.", "Name it.", "Paste the token here."]);
    expect(humanSecretLabel(ASSISTANT_BOT_TOKEN_NAME)).toBe("assistant's Telegram bot token");
  });

  it("tells the agent the bot is connected (no file), and the person one quiet line", () => {
    const message = lateSecretMessage({
      name: ASSISTANT_BOT_TOKEN_NAME,
      cwd: "~",
      outcome: { ok: true, name: ASSISTANT_BOT_TOKEN_NAME, botUsername: "nova_helper_bot" },
    });
    expect(message).toContain("@nova_helper_bot");
    expect(message).not.toContain(".env");
    expect(parseUnoWorkNote(message)).toEqual({
      kind: "assistant-bot-connected",
      text: "You connected @nova_helper_bot. Press Start in Telegram: your assistant says hi there.",
    });
    const declined = parseUnoWorkNote(
      lateSecretMessage({
        name: ASSISTANT_BOT_TOKEN_NAME,
        cwd: "~",
        outcome: { ok: false, error: "declined" },
      }),
    );
    expect(declined?.text).toBe(
      "You skipped the assistant's Telegram bot token. You can add it later.",
    );
  });
});
