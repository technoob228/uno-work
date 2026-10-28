import { describe, expect, it } from "vitest";

import { assistantMailView } from "./assistantMailView.ts";
import { profileHintFixtureTeam } from "./profileHint.test.ts";

const letter = (id: string, direction: "in" | "out", to: string[]) => ({
  id,
  direction,
  from: "x@y.io",
  to,
  subject: `Letter ${id}`,
  snippet: "",
  receivedAt: "2026-10-22T08:00:00Z",
  read: false,
  suspicious: false,
});

describe("an assistant's mail on its page", () => {
  const state = {
    available: true,
    reason: null,
    mailbox: {
      address: "misha-otter@uno4.me",
      local: "misha-otter",
      createdAt: null,
      dailyLimit: 50,
      sentToday: 4,
    },
  };
  const letters = [
    letter("1", "in", ["misha-otter+scout@uno4.me"]),
    letter("2", "in", ["misha-otter@uno4.me"]),
    letter("3", "out", ["a@b.co"]),
  ];
  const ledger = { day: "2026-10-22", sentToday: 1, sentIds: ["3"], messageIds: [] };
  const now = new Date("2026-10-22T12:00:00Z");

  it("its own address, its count and only its letters", () => {
    const view = assistantMailView({
      projectId: "assistant-scout",
      state,
      letters,
      team: profileHintFixtureTeam,
      ledger,
      ownerEmail: "misha@example.com",
      now,
    });
    expect(view).toMatchObject({
      available: true,
      address: "misha-otter+scout@uno4.me",
      computerAddress: "misha-otter@uno4.me",
      sentToday: 1,
      ownerEmail: "misha@example.com",
    });
    expect(view.letters.map((item) => item.id)).toEqual(["1", "3"]);
  });

  it("Uno sees the whole mailbox; no mail here → not available", () => {
    const uno = assistantMailView({
      projectId: "assistant-home",
      state,
      letters,
      team: profileHintFixtureTeam,
      ledger,
      ownerEmail: null,
      now,
    });
    expect(uno.address).toBe("misha-otter@uno4.me");
    expect(uno.letters).toHaveLength(3);
    const off = assistantMailView({
      projectId: "assistant-scout",
      state: { available: false, reason: "not_enabled", mailbox: null },
      letters: [],
      team: profileHintFixtureTeam,
      ledger,
      ownerEmail: null,
      now,
    });
    expect(off).toMatchObject({ available: false, reason: "not_enabled", address: null });
  });
});
