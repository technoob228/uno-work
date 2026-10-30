import { EnvironmentId, type PlanLimitsAccount } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  chatPlanLimit,
  isPlanLimitText,
  pickComputerForNewChat,
  planAtLimit,
  planFullLine,
  planLimitResetFromText,
  planProviderForDriver,
  planRoomPercent,
  planStartedOnLine,
  poolPlans,
  type PlanComputer,
} from "./planRoom.logic";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const WORK = EnvironmentId.make("env-work");
const MAC = EnvironmentId.make("env-mac");
const FREE = EnvironmentId.make("env-free");

function claude(
  email: string,
  fiveHour: number,
  weekly = 20,
  extra: Partial<PlanLimitsAccount> = {},
): PlanLimitsAccount {
  return {
    id: `claude:${email}`,
    provider: "claude",
    plan: "Max 5x",
    email,
    checkedAt: at(-2),
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "5-hour",
        usedPercent: fiveHour,
        resetsAt: at(90),
        windowDurationMins: 300,
      },
      { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: weekly, resetsAt: at(3000) },
    ],
    ...extra,
  };
}

function computer(
  environmentId: EnvironmentId,
  name: string,
  accounts: PlanLimitsAccount[] | null,
  connected = true,
): PlanComputer {
  return { environmentId, name, connected, accounts };
}

describe("planProviderForDriver", () => {
  it("knows the harnesses that run on the person's own plan", () => {
    expect(planProviderForDriver("claudeAgent")).toBe("claude");
    expect(planProviderForDriver("codex")).toBe("chatgpt");
    expect(planProviderForDriver("uno")).toBeNull();
    expect(planProviderForDriver("opencode")).toBeNull();
    expect(planProviderForDriver(null)).toBeNull();
  });
});

describe("planAtLimit / planRoomPercent", () => {
  it("is at its limit while a window is full and not reset yet", () => {
    const hit = planAtLimit(claude("a@x.io", 100), NOW);
    expect(hit?.window.id).toBe("five_hour");
    expect(hit?.resetsAt).toBe(at(90));
  });

  it("waits for the latest of several full windows", () => {
    expect(planAtLimit(claude("a@x.io", 100, 100), NOW)?.resetsAt).toBe(at(3000));
  });

  it("a window that already reset is empty again", () => {
    const account = claude("a@x.io", 100);
    expect(planAtLimit(account, NOW + 91 * 60_000)).toBeNull();
    expect(planRoomPercent(account, NOW + 91 * 60_000)).toBe(80);
  });

  it("extra usage spend is not a wall", () => {
    const account = claude("a@x.io", 10, 10, {
      windows: [
        { id: "five_hour", kind: "session", label: "5-hour", usedPercent: 10 },
        { id: "monthly_spend", kind: "monthly", label: "Extra", usedPercent: 100 },
      ],
    });
    expect(planAtLimit(account, NOW)).toBeNull();
    expect(planRoomPercent(account, NOW)).toBe(90);
  });

  it("room is what the fullest window has left; no numbers — null", () => {
    expect(planRoomPercent(claude("a@x.io", 35, 60), NOW)).toBe(40);
    expect(planRoomPercent(claude("a@x.io", 0, 0, { windows: [] }), NOW)).toBeNull();
  });
});

describe("pickComputerForNewChat", () => {
  const fullHere = computer(WORK, "uno-work", [claude("misha@uno.place", 100)]);

  it("nothing to do for Uno AI or with room here", () => {
    expect(
      pickComputerForNewChat({
        currentEnvironmentId: WORK,
        provider: null,
        computers: [fullHere],
        now: NOW,
      }),
    ).toEqual({ kind: "ok" });
    expect(
      pickComputerForNewChat({
        currentEnvironmentId: WORK,
        provider: "claude",
        computers: [computer(WORK, "uno-work", [claude("misha@uno.place", 40)])],
        now: NOW,
      }),
    ).toEqual({ kind: "ok" });
  });

  it("doesn't guess a wall without numbers here", () => {
    expect(
      pickComputerForNewChat({
        currentEnvironmentId: WORK,
        provider: "claude",
        computers: [computer(WORK, "uno-work", null)],
        now: NOW,
      }).kind,
    ).toBe("ok");
  });

  it("full here: the other computer with its own account and the most room", () => {
    const room = pickComputerForNewChat({
      currentEnvironmentId: WORK,
      provider: "claude",
      computers: [
        fullHere,
        computer(MAC, "MacBook", [claude("work@company.com", 35)]),
        computer(FREE, "free-cloud", [claude("other@x.io", 80)]),
      ],
      now: NOW,
    });
    expect(room.kind).toBe("full");
    if (room.kind !== "full") return;
    expect(room.computerName).toBe("uno-work");
    expect(room.resetsAt).toBe(at(90));
    expect(room.alternative?.environmentId).toBe(MAC);
    expect(room.alternative?.roomPercent).toBe(65);
  });

  it("the same account on another computer is the same bucket — not a way out", () => {
    const room = pickComputerForNewChat({
      currentEnvironmentId: WORK,
      provider: "claude",
      // Older numbers there still show room, but it's the same plan.
      computers: [fullHere, computer(MAC, "MacBook", [claude("misha@uno.place", 60)])],
      now: NOW,
    });
    expect(room.kind === "full" && room.alternative).toBeNull();
  });

  it("skips computers that aren't connected, are full too, or have another provider only", () => {
    const chatgpt: PlanLimitsAccount = {
      id: "chatgpt:misha@uno.place",
      provider: "chatgpt",
      windows: [{ id: "primary", kind: "session", label: "5h", usedPercent: 5 }],
    };
    const room = pickComputerForNewChat({
      currentEnvironmentId: WORK,
      provider: "claude",
      computers: [
        fullHere,
        computer(MAC, "MacBook", [claude("work@company.com", 10)], false),
        computer(FREE, "free-cloud", [claude("other@x.io", 100), chatgpt]),
      ],
      now: NOW,
    });
    expect(room.kind === "full" && room.alternative).toBeNull();
  });

  it("two sign-ins without an email are told apart by their numbers", () => {
    const room = pickComputerForNewChat({
      currentEnvironmentId: WORK,
      provider: "claude",
      computers: [
        computer(WORK, "uno-work", [claude("default", 100, 20, { id: "claude:default" })]),
        computer(MAC, "MacBook", [claude("default", 10, 20, { id: "claude:default" })]),
      ],
      now: NOW,
    });
    expect(room.kind === "full" && room.alternative?.environmentId).toBe(MAC);
  });
});

describe("poolPlans", () => {
  it("one row per account, the same account on two computers once, freshest numbers", () => {
    const pooled = poolPlans(
      [
        computer(WORK, "uno-work", [claude("misha@uno.place", 100, 50, { checkedAt: at(-1) })]),
        computer(MAC, "MacBook", [
          claude("misha@uno.place", 70, 40, { checkedAt: at(-30) }),
          {
            id: "chatgpt:misha@uno.place",
            provider: "chatgpt",
            plan: "Plus",
            windows: [{ id: "primary", kind: "session", label: "5h", usedPercent: 12 }],
          },
        ]),
        computer(FREE, "free-cloud", [claude("work@company.com", 20)]),
      ],
      NOW,
    );
    expect(pooled.map((plan) => plan.provider)).toEqual(["claude", "chatgpt"]);
    const claudePlan = pooled[0]!;
    expect(claudePlan.accounts).toHaveLength(2);
    expect(claudePlan.accounts[0]!.computers.map((c) => c.name)).toEqual(["uno-work", "MacBook"]);
    expect(claudePlan.accounts[0]!.hit?.resetsAt).toBe(at(90));
    expect(claudePlan.withRoom).toBe(1);
    expect(claudePlan.nextResetAt).toBe(at(90));
    expect(pooled[1]!.withRoom).toBe(1);
    expect(pooled[1]!.nextResetAt).toBeNull();
  });
});

describe("isPlanLimitText", () => {
  it.each([
    "You've hit your limit · resets 3pm (Europe/Moscow)",
    "You've hit your session limit · resets 5pm",
    "5-hour limit reached ∙ resets 3pm",
    "Weekly limit reached ∙ resets Nov 3, 1pm",
    "Claude AI usage limit reached|1761840000",
    "You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again at 3:05 PM.",
    "Claude is out of usage",
  ])("stop line: %s", (text) => {
    expect(isPlanLimitText(text)).toBe(true);
  });

  it.each([
    "Approaching usage limit · resets 3pm",
    "Uno AI is busy for you right now",
    "Claude API rate limit reached. Try again later.",
    `Here's how limits work: you've hit your limit when… ${"x".repeat(700)}`,
    null,
  ])("not a stop line: %s", (text) => {
    expect(isPlanLimitText(text)).toBe(false);
  });
});

describe("planLimitResetFromText", () => {
  it("unix seconds after a bar", () => {
    const seconds = Math.floor((NOW + 3 * 3_600_000) / 1000);
    expect(planLimitResetFromText(`Claude AI usage limit reached|${seconds}`, NOW)).toBe(
      new Date(seconds * 1000).toISOString(),
    );
  });

  it("try again in 2 hours 5 minutes", () => {
    expect(
      planLimitResetFromText("You've hit your usage limit. Try again in 2 hours 5 minutes.", NOW),
    ).toBe(at(125));
  });

  it("resets 3pm — the next 3 PM in this time zone", () => {
    const iso = planLimitResetFromText("You've hit your limit · resets 3pm (UTC)", NOW);
    const date = new Date(iso!);
    expect(date.getHours()).toBe(15);
    expect(date.getMinutes()).toBe(0);
    expect(date.getTime()).toBeGreaterThan(NOW);
    expect(date.getTime() - NOW).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it("try again at 3:05 PM", () => {
    const date = new Date(planLimitResetFromText("…or try again at 3:05 PM.", NOW)!);
    expect([date.getHours(), date.getMinutes()]).toEqual([15, 5]);
  });

  it("null when it doesn't say", () => {
    expect(planLimitResetFromText("You've hit your limit", NOW)).toBeNull();
  });
});

describe("chatPlanLimit", () => {
  const computers = [
    computer(WORK, "uno-work", [claude("misha@uno.place", 100)]),
    computer(MAC, "MacBook", [claude("work@company.com", 35)]),
  ];

  it("a Claude chat stopped at the limit: until when, and where it can go on", () => {
    const limit = chatPlanLimit({
      driver: "claudeAgent",
      stopText: "You've hit your limit · resets 3pm",
      currentEnvironmentId: WORK,
      computers,
      now: NOW,
    });
    expect(limit?.provider).toBe("claude");
    expect(limit?.computerName).toBe("uno-work");
    // The computer's numbers know better than the stop line.
    expect(limit?.resetsAt).toBe(at(90));
    expect(limit?.alternative?.computerName).toBe("MacBook");
  });

  it("numbers here not updated yet: trusts the stop line, still finds the other plan", () => {
    const limit = chatPlanLimit({
      driver: "claudeAgent",
      stopText: "You've hit your usage limit. Try again in 45 minutes.",
      currentEnvironmentId: WORK,
      computers: [
        computer(WORK, "uno-work", [claude("misha@uno.place", 97)]),
        computer(MAC, "MacBook", [claude("misha@uno.place", 40)]),
      ],
      now: NOW,
    });
    expect(limit?.resetsAt).toBe(at(45));
    // The MacBook is signed in to the same account — not a way out.
    expect(limit?.alternative).toBeNull();
  });

  it("not for Uno AI, not for other errors", () => {
    expect(
      chatPlanLimit({
        driver: "uno",
        stopText: "You've hit your limit",
        currentEnvironmentId: WORK,
        computers,
        now: NOW,
      }),
    ).toBeNull();
    expect(
      chatPlanLimit({
        driver: "claudeAgent",
        stopText: "Something else broke",
        currentEnvironmentId: WORK,
        computers,
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("words", () => {
  const format = { locale: "en-US", timeZone: "UTC" };
  it("says until when, in plain words", () => {
    expect(
      planFullLine({
        provider: "claude",
        computerName: "uno-work",
        resetsAt: at(90),
        now: NOW,
        format,
      }),
    ).toBe("Claude on uno-work is at its limit until 1:30 PM.");
    expect(
      planFullLine({ provider: "chatgpt", computerName: "MacBook", resetsAt: null, now: NOW }),
    ).toBe("ChatGPT on MacBook is at its limit for now.");
    expect(
      planStartedOnLine({
        startedOn: "MacBook",
        provider: "claude",
        blockedComputerName: "uno-work",
        resetsAt: at(60 * 24 * 2),
        now: NOW,
        format,
      }),
    ).toBe("Started on MacBook — Claude on uno-work is at its limit until Sun 12:00 PM.");
  });
});
