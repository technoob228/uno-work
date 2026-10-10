import { describe, expect, it } from "vitest";

import { relayCredential, routeCredential } from "./channelRelay.ts";
import {
  decideTelegramIngress,
  decideWebhookUpkeep,
  isOwnTelegramWebhook,
  isTelegramWebhookSecretValid,
  isWebhookConflict,
  parseMachineIngress,
  telegramWebhookHookId,
  telegramWebhookSecret,
  telegramWebhookUrl,
  WEBHOOK_ERROR_FRESH_MS,
  type MachineIngress,
} from "./telegramWebhook.ts";

const BOT = "123456:AAExampleExampleExampleExampleExample";
const OTHER_BOT = "654321:AAOtherOtherOtherOtherOtherOtherOth";
const ADDRESS = "https://mybox-bcdfghjkmn.app.uno4.dev";

const economyComputer: MachineIngress = { publicUrl: ADDRESS, economy: true, wakeOnHttp: true };

describe("the webhook address and secret", () => {
  it("are derived from the bot token: stable, per bot, and give the token away nowhere", () => {
    expect(telegramWebhookHookId(BOT)).toBe(telegramWebhookHookId(BOT));
    expect(telegramWebhookSecret(BOT)).toBe(telegramWebhookSecret(BOT));
    expect(telegramWebhookHookId(BOT)).not.toBe(telegramWebhookHookId(OTHER_BOT));
    expect(telegramWebhookSecret(BOT)).not.toBe(telegramWebhookSecret(OTHER_BOT));
    expect(telegramWebhookHookId(BOT)).not.toBe(telegramWebhookSecret(BOT).slice(0, 32));

    const url = telegramWebhookUrl(`${ADDRESS}/`, BOT);
    expect(url).toBe(`${ADDRESS}/api/telegram/webhook/${telegramWebhookHookId(BOT)}`);
    for (const shown of [url, telegramWebhookSecret(BOT)]) {
      expect(shown).not.toContain(BOT);
      expect(shown).not.toContain(BOT.split(":")[1]);
    }
    // Telegram accepts 1–256 characters of A-Z a-z 0-9 _ - as secret_token.
    expect(telegramWebhookSecret(BOT)).toMatch(/^[A-Za-z0-9_-]{1,256}$/);
  });

  it("only this bot's secret opens the door", () => {
    expect(isTelegramWebhookSecretValid(BOT, telegramWebhookSecret(BOT))).toBe(true);
    expect(isTelegramWebhookSecretValid(BOT, telegramWebhookSecret(OTHER_BOT))).toBe(false);
    expect(isTelegramWebhookSecretValid(BOT, telegramWebhookSecret(BOT).slice(0, -1))).toBe(false);
    expect(isTelegramWebhookSecretValid(BOT, "")).toBe(false);
    expect(isTelegramWebhookSecretValid(BOT, null)).toBe(false);
    expect(isTelegramWebhookSecretValid(BOT, undefined)).toBe(false);
  });

  it("knows its own webhook on any Uno address, and nobody else's", () => {
    expect(isOwnTelegramWebhook(telegramWebhookUrl(ADDRESS, BOT), BOT)).toBe(true);
    // A previous address of the computer (the label changed, a restored copy).
    expect(isOwnTelegramWebhook(telegramWebhookUrl("https://old.app.uno4.dev", BOT), BOT)).toBe(
      true,
    );
    expect(isOwnTelegramWebhook(telegramWebhookUrl(ADDRESS, OTHER_BOT), BOT)).toBe(false);
    expect(isOwnTelegramWebhook("https://my-own-service.example/telegram", BOT)).toBe(false);
    expect(isOwnTelegramWebhook("", BOT)).toBe(false);
    expect(isOwnTelegramWebhook(undefined, BOT)).toBe(false);
  });
});

describe("what the console says about this computer", () => {
  it("reads the address, economy mode and wake-on-request from the box", () => {
    expect(
      parseMachineIngress({
        id: 77,
        hostname: "mybox-bcdfghjkmn.app.uno4.dev",
        url: ADDRESS,
        wake_on_http: true,
        economy: { enabled: true, state: "awake" },
      }),
    ).toEqual(economyComputer);
  });

  it("an always-on computer, one without an address, a malformed answer", () => {
    expect(parseMachineIngress({ url: ADDRESS, wake_on_http: true })).toEqual({
      publicUrl: ADDRESS,
      economy: false,
      wakeOnHttp: true,
    });
    expect(
      parseMachineIngress({ url: ADDRESS, wake_on_http: true, economy: { enabled: false } }),
    ).toMatchObject({ economy: false });
    // No inbound port 80 yet: the console names a hostname but no working url.
    expect(
      parseMachineIngress({ hostname: "x.app.uno4.dev", economy: { enabled: true } }),
    ).toMatchObject({ publicUrl: null, wakeOnHttp: false });
    expect(parseMachineIngress({ url: "http://plain.example" })).toMatchObject({ publicUrl: null });
    expect(parseMachineIngress({ url: `${ADDRESS}/some/path` })).toMatchObject({ publicUrl: null });
    expect(parseMachineIngress(null)).toBeNull();
    expect(parseMachineIngress("nope")).toBeNull();
    expect(parseMachineIngress([])).toBeNull();
  });
});

describe("long polling or a webhook", () => {
  it("a webhook only for the person's own bot on an economy computer its address wakes", () => {
    expect(decideTelegramIngress({ botToken: BOT, machine: economyComputer })).toEqual({
      mode: "webhook",
      url: telegramWebhookUrl(ADDRESS, BOT),
    });
  });

  it("everywhere else nothing changes: long polling", () => {
    const poll = { mode: "poll" };
    // Always-on computer.
    expect(
      decideTelegramIngress({ botToken: BOT, machine: { ...economyComputer, economy: false } }),
    ).toEqual(poll);
    // The address does not wake it (the owner switched that off).
    expect(
      decideTelegramIngress({ botToken: BOT, machine: { ...economyComputer, wakeOnHttp: false } }),
    ).toEqual(poll);
    // No web address.
    expect(
      decideTelegramIngress({ botToken: BOT, machine: { ...economyComputer, publicUrl: null } }),
    ).toEqual(poll);
    // A laptop / a server of one's own / the console has not answered yet.
    expect(decideTelegramIngress({ botToken: BOT, machine: null })).toEqual(poll);
    // Uno's shared bot already wakes the computer through the console's relay.
    expect(
      decideTelegramIngress({
        botToken: relayCredential("tgr_" + "a".repeat(40)),
        machine: economyComputer,
      }),
    ).toEqual(poll);
    expect(
      decideTelegramIngress({ botToken: routeCredential("project-1"), machine: economyComputer }),
    ).toEqual(poll);
  });
});

describe("looking after the webhook", () => {
  const desiredUrl = telegramWebhookUrl(ADDRESS, BOT);
  const nowMs = 1_800_000_000_000;
  const base = { desiredUrl, botToken: BOT, nowMs, lastDrainAtMs: 0 };
  const secondsAgo = (seconds: number) => Math.floor(nowMs / 1000) - seconds;

  it("no webhook yet, or ours on a previous address: point it here", () => {
    expect(decideWebhookUpkeep({ ...base, info: { url: "" } })).toBe("set");
    expect(decideWebhookUpkeep({ ...base, info: {} })).toBe("set");
    expect(
      decideWebhookUpkeep({
        ...base,
        info: { url: telegramWebhookUrl("https://old.app.uno4.dev", BOT) },
      }),
    ).toBe("set");
  });

  it("ours and delivering: leave it", () => {
    expect(decideWebhookUpkeep({ ...base, info: { url: desiredUrl } })).toBe("ok");
    // Something is on its way right now, no failure: Telegram is delivering.
    expect(
      decideWebhookUpkeep({ ...base, info: { url: desiredUrl, pending_update_count: 2 } }),
    ).toBe("ok");
  });

  it("somebody else's webhook is not ours to move", () => {
    expect(
      decideWebhookUpkeep({ ...base, info: { url: "https://my-own-service.example/telegram" } }),
    ).toBe("foreign");
    expect(
      decideWebhookUpkeep({
        ...base,
        info: {
          url: "https://my-own-service.example/telegram",
          pending_update_count: 3,
          last_error_date: secondsAgo(5),
        },
      }),
    ).toBe("foreign");
  });

  it("Telegram holds updates it just failed to deliver: fetch them ourselves", () => {
    expect(
      decideWebhookUpkeep({
        ...base,
        info: { url: desiredUrl, pending_update_count: 1, last_error_date: secondsAgo(20) },
      }),
    ).toBe("drain");
  });

  it("an old failure, or one already dealt with, is not a reason to fetch again", () => {
    expect(
      decideWebhookUpkeep({
        ...base,
        info: {
          url: desiredUrl,
          pending_update_count: 1,
          last_error_date: secondsAgo(WEBHOOK_ERROR_FRESH_MS / 1000 + 60),
        },
      }),
    ).toBe("ok");
    expect(
      decideWebhookUpkeep({
        ...base,
        lastDrainAtMs: nowMs - 10_000,
        info: { url: desiredUrl, pending_update_count: 1, last_error_date: secondsAgo(20) },
      }),
    ).toBe("ok");
    // A failure with nothing left waiting: Telegram got it through on a retry.
    expect(
      decideWebhookUpkeep({
        ...base,
        info: { url: desiredUrl, pending_update_count: 0, last_error_date: secondsAgo(20) },
      }),
    ).toBe("ok");
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
