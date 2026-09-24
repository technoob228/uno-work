import { describe, expect, it } from "vitest";

import {
  checkBotToken,
  describeTelegramChatDestination,
  describeTestResults,
  isBotTokenRejected,
  telegramChatDestination,
  telegramStartLink,
  telegramWizardStep,
} from "./connectTelegram.logic";

describe("telegramWizardStep", () => {
  const base = { configured: true, allowedChatIds: [], botUsername: "uno_bot", health: null };
  it("walks bot → link → done", () => {
    expect(telegramWizardStep({ ...base, configured: false }, { linkingAnother: false })).toBe(
      "bot",
    );
    expect(telegramWizardStep(base, { linkingAnother: false })).toBe("link");
    expect(telegramWizardStep({ ...base, allowedChatIds: ["1"] }, { linkingAnother: false })).toBe(
      "done",
    );
    expect(telegramWizardStep({ ...base, allowedChatIds: ["1"] }, { linkingAnother: true })).toBe(
      "link",
    );
  });

  it("goes back to the token when Telegram refused it", () => {
    const rejected = {
      ...base,
      botUsername: null,
      health: {
        status: "auth_expired",
        lastOkAt: null,
        lastError: "Unauthorized",
        lastErrorAt: null,
      },
    } as const;
    expect(isBotTokenRejected(rejected)).toBe(true);
    expect(telegramWizardStep(rejected, { linkingAnother: false })).toBe("bot");
  });
});

describe("checkBotToken", () => {
  it("accepts a BotFather token and explains anything else", () => {
    expect(checkBotToken(" 123456789:AAEabcdefghijklmnopqrstuvwxyz ")).toBeNull();
    expect(checkBotToken("hello")).toContain("123456789:AAE");
  });
});

describe("telegramStartLink", () => {
  it("carries the code as the start payload", () => {
    expect(telegramStartLink("uno_bot", "uno0a1b")).toBe("https://t.me/uno_bot?start=uno0a1b");
  });
});

describe("telegramChatDestination", () => {
  it("tells the main conversation, the chat's own one and anything else apart", () => {
    const main = "thread-main";
    expect(telegramChatDestination(undefined, main)).toEqual({ kind: "own" });
    expect(
      telegramChatDestination(
        { target: { kind: "assistant", projectId: "assistant-home" as never }, targetLabel: null },
        main,
      ),
    ).toEqual({ kind: "own" });
    expect(
      telegramChatDestination(
        { target: { kind: "thread", threadId: main as never }, targetLabel: "Uno" },
        main,
      ),
    ).toEqual({ kind: "main" });
    const project = telegramChatDestination(
      { target: { kind: "project", projectId: "p" as never }, targetLabel: "Site" },
      main,
    );
    expect(project).toEqual({ kind: "other", label: "Site" });
    expect(describeTelegramChatDestination(project)).toBe("Site");
    expect(describeTelegramChatDestination({ kind: "main" })).toBe("Uno, main conversation");
  });
});

describe("describeTestResults", () => {
  it("says sent, or why not", () => {
    expect(describeTestResults([])).toEqual({ ok: false, text: "No chat is linked yet." });
    expect(describeTestResults([{ ok: true, error: null }]).text).toBe("Sent. Check Telegram.");
    expect(
      describeTestResults([
        { ok: true, error: null },
        { ok: false, error: "Forbidden: bot was blocked by the user" },
      ]),
    ).toEqual({
      ok: false,
      text: "Telegram didn't take it: Forbidden: bot was blocked by the user",
    });
  });
});
