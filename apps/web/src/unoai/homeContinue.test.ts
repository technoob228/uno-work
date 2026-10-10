import { describe, expect, it } from "vitest";

import type { FreeBotStatus } from "./freeBot";
import { botTitle, continueCards, type ContinueInput } from "./homeContinue";

const NOW = Date.parse("2026-10-09T18:00:00Z");

const draft: FreeBotStatus = {
  enabled: true,
  days: 7,
  state: "draft",
  on_free_days: false,
  spec: { name: "Bean & Bun" },
};

const base: ContinueInput = {
  now: NOW,
  freeBot: null,
  resume: { botChatId: "c-bot", lastChatId: "c-last", site: null },
  liveSiteSlugs: new Set(),
  hasPlan: false,
};

describe("continueCards (Uno AI Home, icp3 n1/12)", () => {
  it("nothing started — nothing to continue", () => {
    expect(continueCards(base)).toEqual([]);
    expect(continueCards({ ...base, freeBot: { ...draft, state: "none" } })).toEqual([]);
  });

  it("a bot draft: one step left, Continue opens the chat it was made in", () => {
    const [card] = continueCards({ ...base, freeBot: draft });
    expect(card).toMatchObject({
      key: "bot",
      title: "Continue: Bean & Bun bot",
      primary: { label: "Continue", chat: "c-bot" },
    });
    expect(card?.line).toBe(
      "One step left: create the bot in @BotFather and paste its token. It starts answering in a minute and runs free for 7 days.",
    );
  });

  it("an account without an email hears that first; a plan doesn't need it", () => {
    const fb = { ...draft, reason: "FREE_BOT_EMAIL_REQUIRED" };
    expect(continueCards({ ...base, freeBot: fb })[0]?.line).toMatch(/needs an email/);
    expect(continueCards({ ...base, freeBot: fb, hasPlan: true })[0]?.line).toMatch(
      /^One step left/,
    );
  });

  it("a live bot opens in Telegram, the chat changes it", () => {
    const [card] = continueCards({
      ...base,
      freeBot: {
        ...draft,
        state: "live",
        on_free_days: true,
        free_until: "2026-10-16",
        bot: { username: "beanbun_bot", url: "https://t.me/beanbun_bot", messages_answered: 3 },
      },
    });
    expect(card).toMatchObject({
      title: "@beanbun_bot is live",
      primary: { label: "Open in Telegram", href: "https://t.me/beanbun_bot" },
      secondary: { label: "Change it with Uno", chat: "c-bot" },
    });
  });

  it("an asleep bot offers Keep it on", () => {
    const [card] = continueCards({
      ...base,
      freeBot: {
        ...draft,
        state: "ended",
        keep_on: { plan: "plus", name: "Plus", price_usd: 20, checkout_url: "https://x/checkout" },
      },
    });
    expect(card?.primary).toEqual({ label: "Keep it on — $20/mo", href: "https://x/checkout" });
  });

  it("a site Uno made shows while it exists and the chat is fresh", () => {
    const site = {
      chatId: "c-site",
      slug: "lotus-flow",
      url: "https://lotus-flow.uno4.me",
      title: "Lotus Flow",
      updatedAt: "2026-10-09T03:00:00Z",
    };
    const resume = { botChatId: "c-bot", lastChatId: "c-last", site };
    const live = new Set(["lotus-flow"]);
    const cards = continueCards({ ...base, freeBot: draft, resume, liveSiteSlugs: live });
    expect(cards.map((c) => c.key)).toEqual(["bot", "site"]);
    expect(cards[1]).toMatchObject({
      title: "Continue: Lotus Flow",
      primary: { label: "Continue", chat: "c-site" },
      secondary: { label: "View site", href: "https://lotus-flow.uno4.me" },
    });
    // Deleted, unknown or old — not "continue".
    expect(continueCards({ ...base, resume, liveSiteSlugs: new Set() })).toEqual([]);
    expect(continueCards({ ...base, resume, liveSiteSlugs: null })).toEqual([]);
    expect(
      continueCards({
        ...base,
        resume: { ...resume, site: { ...site, updatedAt: "2026-09-01T00:00:00Z" } },
        liveSiteSlugs: live,
      }),
    ).toEqual([]);
  });

  it("names the bot like the console", () => {
    expect(botTitle("Pizza bot")).toBe("Pizza bot");
    expect(botTitle("")).toBe("your bot");
  });
});
