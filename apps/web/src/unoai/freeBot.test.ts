import { describe, expect, it } from "vitest";

import {
  extractBotToken,
  formatFreeUntil,
  freeBotPollMs,
  keepOnLabel,
  liveMetaLine,
  liveTileLine,
  looksLikeBotToken,
  tokenErrorOffersPlan,
  type FreeBotStatus,
} from "./freeBot";

const TOKEN = "7712345678:AAHk3sQ_x9Lr0abcdefghijklmnopqrstuv";

const live: FreeBotStatus = {
  enabled: true,
  days: 7,
  state: "live",
  on_free_days: true,
  free_until: "2026-10-12T09:00:00Z",
  bot: {
    username: "crumb_bakery_bot",
    url: "https://t.me/crumb_bakery_bot",
    owner_url: "https://t.me/crumb_bakery_bot?start=own_x",
    app_server_id: 12,
    messages_answered: 37,
  },
  keep_on: { plan: "plus", name: "Plus", price_usd: 20, checkout_url: "https://x/checkout" },
};

describe("free bot", () => {
  it("takes the token out of BotFather's whole message", () => {
    const msg = `Done! Congratulations on your new bot.\nUse this token to access the HTTP API:\n${TOKEN}\nKeep your token secure`;
    expect(extractBotToken(msg)).toBe(TOKEN);
    expect(extractBotToken(`  ${TOKEN} `)).toBe(TOKEN);
    expect(extractBotToken(" junk ")).toBe("junk");
    expect(looksLikeBotToken(`here: ${TOKEN}`)).toBe(true);
    expect(looksLikeBotToken("call me at 12:30")).toBe(false);
  });
  it("polls fast only while the bot starts", () => {
    expect(freeBotPollMs("starting")).toBe(3_000);
    expect(freeBotPollMs("live")).toBe(30_000);
    expect(freeBotPollMs(undefined)).toBe(30_000);
  });
  it("writes the dates, the price and the counts plainly", () => {
    expect(formatFreeUntil("2026-10-12T09:00:00Z", "en-US")).toBe("Oct 12");
    expect(formatFreeUntil("Oct 12", "en-US")).toBe("Oct 12");
    expect(formatFreeUntil(undefined)).toBeNull();
    expect(keepOnLabel(live.keep_on)).toBe("Keep it on — $20/mo");
    expect(keepOnLabel(undefined)).toBe("Keep it on");
    expect(liveMetaLine(live, "en-US")).toBe("Free until Oct 12 · answered 37 messages");
    expect(
      liveMetaLine({ ...live, on_free_days: false, bot: { ...live.bot!, messages_answered: 1 } }),
    ).toBe("Answered 1 message");
  });
  it("puts the bot in one sidebar line", () => {
    expect(liveTileLine(live, "en-US")).toBe("@crumb_bakery_bot · free until Oct 12 · answered 37");
    expect(liveTileLine({ ...live, state: "starting" })).toBe("@crumb_bakery_bot · starting");
    expect(liveTileLine({ ...live, state: "ended", on_free_days: false })).toBe(
      "@crumb_bakery_bot · asleep · answered 37",
    );
    const { bot: _bot, ...noBot } = live;
    expect(liveTileLine(noBot)).toBeNull();
  });
  it("offers the plan when the free days aren't there", () => {
    expect(tokenErrorOffersPlan("FREE_BOT_FULL")).toBe(true);
    expect(tokenErrorOffersPlan("FREE_BOT_ENDED")).toBe(true);
    expect(tokenErrorOffersPlan("FREE_BOT_BAD_TOKEN")).toBe(false);
  });
});
