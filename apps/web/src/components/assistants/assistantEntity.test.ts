import type {
  ManagerSlackConnectorStatus,
  ManagerTelegramConnectorStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  ASSISTANT_CREATED_KEY,
  ASSISTANT_DELETED,
  assistantEntity,
  assistantWhereLine,
  withAgentsProfile,
  withAssistantProfile,
  withAssistantWhere,
  withoutAssistant,
} from "./assistantEntity";

const ADDRESSING = {
  names: [],
  requireMentionInGroups: true,
  smartWake: false,
  hotWindowSec: 0,
} as unknown as ManagerTelegramConnectorStatus["addressing"];

function telegram(
  patch: Partial<ManagerTelegramConnectorStatus> = {},
): ManagerTelegramConnectorStatus {
  return {
    configured: false,
    enabled: false,
    allowedChatIds: [],
    botUsername: null,
    lastError: null,
    health: null,
    defaultModelSelection: null,
    addressing: ADDRESSING,
    shared: false,
    ...patch,
  };
}

function slack(patch: Partial<ManagerSlackConnectorStatus> = {}): ManagerSlackConnectorStatus {
  return {
    configured: false,
    enabled: false,
    allowedChannelIds: [],
    botUserId: null,
    botUserName: null,
    lastError: null,
    defaultModelSelection: null,
    addressing: ADDRESSING,
    ...patch,
  } as ManagerSlackConnectorStatus;
}

const EMPTY = {
  mode: null,
  visited: [],
  skipped: [],
  finished: false,
  dismissed: false,
  project: null,
  answers: {},
} as const;

describe("assistantEntity", () => {
  it("is empty by default: nothing created, nothing connected", () => {
    expect(assistantEntity(EMPTY, { telegram: telegram(), slack: slack() })).toBeNull();
    expect(assistantEntity(EMPTY, { telegram: null, slack: null })).toBeNull();
  });

  it("shows an assistant that was created here", () => {
    const progress = withAssistantProfile(EMPTY, {
      name: "  Bakery bot ",
      about: "Answers about cakes",
      now: "2026-10-01T10:00:00.000Z",
    });
    const entity = assistantEntity(progress, { telegram: telegram(), slack: slack() });
    expect(entity?.name).toBe("Bakery bot");
    expect(entity?.about).toBe("Answers about cakes");
    expect(entity?.createdAt).toBe("2026-10-01T10:00:00.000Z");
    expect(assistantWhereLine(entity!)).toBe("Only here, in Uno Work");
  });

  it("shows an assistant that already answers in Telegram, named Uno", () => {
    const entity = assistantEntity(EMPTY, {
      telegram: telegram({
        configured: true,
        enabled: true,
        allowedChatIds: ["42"],
        botUsername: "get_uno_bot",
        shared: true,
      }),
      slack: slack(),
    });
    expect(entity?.name).toBe("Uno");
    expect(entity?.telegramOn).toBe(true);
    expect(entity?.telegramShared).toBe(true);
    expect(assistantWhereLine(entity!)).toBe("Telegram · @get_uno_bot");
  });

  it("shows the onboarding's assistant", () => {
    const entity = assistantEntity(
      { ...EMPTY, answers: { goal: "assistant" } },
      { telegram: telegram(), slack: slack() },
    );
    expect(entity).not.toBeNull();
  });

  it("is paused when the connectors are set up but switched off", () => {
    const entity = assistantEntity(EMPTY, {
      telegram: telegram({ configured: true, enabled: false, allowedChatIds: ["42"] }),
      slack: slack(),
    });
    expect(entity?.paused).toBe(true);
    expect(entity?.telegramOn).toBe(false);
  });

  it("leaves the list after delete, even with the onboarding goal", () => {
    const created = withAssistantWhere(
      withAssistantProfile(
        { ...EMPTY, answers: { goal: "assistant" } },
        { name: "A", about: "", now: "2026-10-01T10:00:00.000Z" },
      ),
      "telegram",
    );
    const deleted = withoutAssistant(created);
    expect(deleted.answers[ASSISTANT_CREATED_KEY]).toBe(ASSISTANT_DELETED);
    expect(assistantEntity(deleted, { telegram: telegram(), slack: slack() })).toBeNull();
    // Created again: a fresh date, not the "deleted" marker.
    const again = withAssistantProfile(deleted, {
      name: "B",
      about: "",
      now: "2026-10-02T00:00:00.000Z",
    });
    expect(assistantEntity(again, { telegram: null, slack: null })?.createdAt).toBe(
      "2026-10-02T00:00:00.000Z",
    );
  });
});

describe("withAgentsProfile", () => {
  it("appends the profile block once and replaces it later", () => {
    const first = withAgentsProfile("# Rules\n\nBe kind.\n", { name: "Bea", about: "Sells cakes" });
    expect(first).toContain("# Rules\n\nBe kind.\n\n<!-- uno:assistant-profile -->");
    expect(first).toContain("Your name is Bea.");
    expect(first).toContain("What you do: Sells cakes");
    const second = withAgentsProfile(first, { name: "Ann", about: "" });
    expect(second).toContain("Your name is Ann.");
    expect(second).not.toContain("Bea");
    expect(second).not.toContain("What you do");
    expect(second.match(/<!-- uno:assistant-profile -->/g)).toHaveLength(1);
    expect(second.startsWith("# Rules\n\nBe kind.")).toBe(true);
  });
});
