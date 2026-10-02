import { describe, expect, it } from "vitest";

import { humanSecretLabel, lateSecretMessage, secretRequestTitle } from "./secretRequestNotify.ts";

describe("secret request wording", () => {
  it("names common secrets in plain words", () => {
    expect(humanSecretLabel("TELEGRAM_BOT_TOKEN")).toBe("Telegram bot token");
    expect(humanSecretLabel("OPENAI_API_KEY")).toBe("OpenAI API key");
    expect(humanSecretLabel("DB_PASSWORD")).toBe("db password");
    expect(humanSecretLabel("WEBHOOK_URL")).toBe("WEBHOOK_URL");
  });

  it("titles the Inbox item", () => {
    expect(secretRequestTitle("TELEGRAM_BOT_TOKEN")).toBe("Uno needs your Telegram bot token");
    expect(secretRequestTitle("CHAT_ID")).toBe("Uno needs a secret (CHAT_ID)");
  });

  it("tells the chat where the value went, never the value", () => {
    const saved = lateSecretMessage({
      name: "TELEGRAM_BOT_TOKEN",
      cwd: "/home/unowork/projects/bot",
      outcome: { ok: true, name: "TELEGRAM_BOT_TOKEN", file: ".env" },
    });
    expect(saved).toContain("/home/unowork/projects/bot/.env");
    expect(saved).toContain("continue");
    const declined = lateSecretMessage({
      name: "TELEGRAM_BOT_TOKEN",
      cwd: "/p",
      outcome: { ok: false, error: "The user declined to provide this secret." },
    });
    expect(declined).toContain("didn't give");
  });
});
