import { describe, expect, it } from "vitest";

import {
  isOwnTelegramWebhook,
  isWebhookConflict,
  TELEGRAM_WEBHOOK_PATH_PREFIX,
  telegramWebhookHookId,
} from "./telegramWebhook.ts";

const BOT = "123456:AAExampleExampleExampleExampleExample";
const OTHER_BOT = "654321:AAOtherOtherOtherOtherOtherOtherOth";
const ADDRESS = "https://mybox-bcdfghjkmn.app.uno4.dev";
const ownWebhookOn = (address: string, botToken: string) =>
  `${address}${TELEGRAM_WEBHOOK_PATH_PREFIX}${telegramWebhookHookId(botToken)}`;

describe("what counts as Uno Work's own webhook — a contract between versions", () => {
  it("the path and the id are pinned: a version that only polls must recognise what a later one set", () => {
    // Changing either value strands bots on computers rolled back to a
    // version that still expects the old one. Do not change them.
    expect(TELEGRAM_WEBHOOK_PATH_PREFIX).toBe("/api/telegram/webhook/");
    expect(telegramWebhookHookId(BOT)).toBe("1a5776bc1aa7af8405da3a40ee486c75");
    expect(ownWebhookOn(ADDRESS, BOT)).toBe(
      "https://mybox-bcdfghjkmn.app.uno4.dev/api/telegram/webhook/1a5776bc1aa7af8405da3a40ee486c75",
    );
  });

  it("the id is per bot and gives the token away nowhere", () => {
    expect(telegramWebhookHookId(BOT)).toBe(telegramWebhookHookId(BOT));
    expect(telegramWebhookHookId(BOT)).not.toBe(telegramWebhookHookId(OTHER_BOT));
    expect(ownWebhookOn(ADDRESS, BOT)).not.toContain(BOT);
    expect(ownWebhookOn(ADDRESS, BOT)).not.toContain(BOT.split(":")[1]);
  });

  it("ours on any address: this computer's, a previous one, a copy of the computer", () => {
    expect(isOwnTelegramWebhook(ownWebhookOn(ADDRESS, BOT), BOT)).toBe(true);
    expect(isOwnTelegramWebhook(ownWebhookOn("https://old-name-xyz.app.uno4.dev", BOT), BOT)).toBe(
      true,
    );
    expect(isOwnTelegramWebhook(ownWebhookOn("https://abcdefghjk.uno4.work", BOT), BOT)).toBe(true);
  });

  it("not ours: another service, another bot's id, a look-alike path, plain http, nothing", () => {
    expect(isOwnTelegramWebhook("https://my-own-service.example/telegram", BOT)).toBe(false);
    expect(isOwnTelegramWebhook(ownWebhookOn(ADDRESS, OTHER_BOT), BOT)).toBe(false);
    // A person's own app on an Uno address that happens to use the same path.
    expect(
      isOwnTelegramWebhook(`https://myapp-bcdfghjkmn.app.uno4.dev/api/telegram/webhook/mybot`, BOT),
    ).toBe(false);
    expect(isOwnTelegramWebhook(`${ADDRESS}${TELEGRAM_WEBHOOK_PATH_PREFIX}`, BOT)).toBe(false);
    expect(isOwnTelegramWebhook(ownWebhookOn("http://mybox.app.uno4.dev", BOT), BOT)).toBe(false);
    expect(isOwnTelegramWebhook(`${ownWebhookOn(ADDRESS, BOT)}/more`, BOT)).toBe(false);
    expect(isOwnTelegramWebhook("", BOT)).toBe(false);
    expect(isOwnTelegramWebhook(null, BOT)).toBe(false);
    expect(isOwnTelegramWebhook(undefined, BOT)).toBe(false);
  });
});

describe("getUpdates refused because of a webhook", () => {
  it("is told apart from two pollers fighting", () => {
    expect(
      isWebhookConflict(
        409,
        "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
      ),
    ).toBe(true);
    expect(
      isWebhookConflict(
        409,
        "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
      ),
    ).toBe(false);
    expect(isWebhookConflict(401, "Unauthorized")).toBe(false);
    expect(isWebhookConflict(undefined, undefined)).toBe(false);
  });
});
