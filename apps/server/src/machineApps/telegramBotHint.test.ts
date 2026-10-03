import { describe, expect, it } from "vitest";

import { pickTokenEnv, saysTelegramBot, scanTelegramBotTexts } from "./telegramBotHint.ts";

describe("is the app a Telegram bot", () => {
  it("hears it in what the agent wrote", () => {
    expect(saysTelegramBot({ name: "Orders Telegram bot" })).toBe(true);
    expect(saysTelegramBot({ name: "Orders", command: "python3 tg_bot.py" })).toBe(true);
    expect(saysTelegramBot({ name: "Slack bot", command: "node bot.js" })).toBe(false);
    expect(saysTelegramBot({ name: "Notes", port: 3000 })).toBe(false);
  });

  it("sees a Telegram library and the token variable in the code", () => {
    expect(
      scanTelegramBotTexts([
        { name: "requirements.txt", text: "python-telegram-bot==21.0\n" },
        { name: "bot.py", text: 'TOKEN = os.getenv("BOT_TOKEN")\nDB = os.getenv("DB_URL")\n' },
      ]),
    ).toEqual({ isBot: true, tokenEnv: "BOT_TOKEN" });
    expect(
      scanTelegramBotTexts([
        { name: "package.json", text: '{"dependencies":{"grammy":"^1"}}' },
        { name: "index.ts", text: "new Bot(process.env.TELEGRAM_BOT_TOKEN!)" },
        { name: ".env.example", text: "TELEGRAM_BOT_TOKEN=\nOPENAI_TOKEN=\n" },
      ]),
    ).toEqual({ isBot: true, tokenEnv: "TELEGRAM_BOT_TOKEN" });
  });

  it("doesn't call an ordinary program a bot", () => {
    expect(
      scanTelegramBotTexts([{ name: "app.py", text: 'KEY = os.environ["API_TOKEN"]\n' }]),
    ).toEqual({ isBot: false, tokenEnv: null });
  });

  it("prefers the most Telegram-looking token name", () => {
    expect(pickTokenEnv(["TOKEN", "BOT_TOKEN", "TELEGRAM_BOT_TOKEN"])).toBe("TELEGRAM_BOT_TOKEN");
    expect(pickTokenEnv(["API_TOKEN", "TG_TOKEN"])).toBe("TG_TOKEN");
    expect(pickTokenEnv(["DATABASE_URL"])).toBeNull();
  });
});
