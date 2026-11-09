import type { PlanLimitsAccount } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_SWITCH_NOTE_BODY,
  blocksWork,
  PLAN_RESUME_ENDED_ACTIVITY,
  PLAN_RESUME_GRACE_MS,
  PLAN_RESUME_NOTE_BODY,
  PLAN_RESUME_SCHEDULED_ACTIVITY,
  pendingPlanResume,
  planAccountForInstance,
  planResumeTime,
} from "./planLimitRules.ts";
import { parseUnoWorkNote, UNO_WORK_NOTE_PREFIX } from "./secretRequestCopy.ts";

const NOW = Date.parse("2026-10-30T10:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const account = (over: Partial<PlanLimitsAccount> = {}): PlanLimitsAccount => ({
  id: "claude:a@b.c",
  provider: "claude",
  windows: [
    { id: "five_hour", kind: "session", label: "5-hour", usedPercent: 100, resetsAt: at(90) },
  ],
  ...over,
});

describe("planResumeTime", () => {
  it("takes the reset from the plan's numbers first, a little after it", () => {
    const time = planResumeTime({
      account: account(),
      model: null,
      stopText: "You've hit your limit · resets 3pm",
      now: NOW,
    });
    expect(time).toEqual({
      kind: "at",
      resumeAt: new Date(Date.parse(at(90)) + PLAN_RESUME_GRACE_MS).toISOString(),
      source: "plan",
    });
  });

  it("falls back to the stop line when the numbers are older than the stop", () => {
    const time = planResumeTime({
      account: account({
        windows: [
          { id: "five_hour", kind: "session", label: "5-hour", usedPercent: 91, resetsAt: at(90) },
        ],
      }),
      model: null,
      stopText: "You've hit your usage limit. Try again in 2 hours",
      now: NOW,
    });
    expect(time).toMatchObject({ kind: "at", source: "text" });
    expect(time.kind === "at" && Date.parse(time.resumeAt)).toBe(
      NOW + 120 * 60_000 + PLAN_RESUME_GRACE_MS,
    );
  });

  it("doesn't guess: no time said, no schedule", () => {
    expect(
      planResumeTime({
        account: null,
        model: null,
        stopText: "You've hit your usage limit.",
        now: NOW,
      }),
    ).toEqual({ kind: "unknown" });
  });

  it("waits for the last full window: the weekly one outlasts the 5-hour", () => {
    const time = planResumeTime({
      account: account({
        windows: [
          { id: "five_hour", kind: "session", label: "5-hour", usedPercent: 100, resetsAt: at(90) },
          { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 100, resetsAt: at(600) },
        ],
      }),
      model: null,
      stopText: "limit reached",
      now: NOW,
    });
    expect(time).toMatchObject({ kind: "at", source: "plan" });
    expect(time.kind === "at" && Date.parse(time.resumeAt)).toBeGreaterThan(NOW + 590 * 60_000);
  });

  it("treats a reset past a week away as a misread", () => {
    expect(
      planResumeTime({
        account: account({
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "5-hour",
              usedPercent: 100,
              resetsAt: at(60 * 24 * 30),
            },
          ],
        }),
        model: null,
        stopText: "limit",
        now: NOW,
      }),
    ).toEqual({ kind: "too-far" });
  });
});

describe("a limit on one model", () => {
  const scoped = (scope: string) =>
    ({
      id: "seven_day_x",
      kind: "weekly",
      label: `Weekly · ${scope}`,
      usedPercent: 100,
      scope,
    }) as const;

  it("stops that model, by its family, and no other", () => {
    expect(blocksWork(scoped("Fable"), "claude-fable-5-1")).toBe(true);
    // A newer Fable the CLI brought (09.11: 5.2, Claude Code 2.1.321) and its alias.
    expect(blocksWork(scoped("Fable"), "claude-fable-5-2")).toBe(true);
    expect(blocksWork(scoped("Fable"), "fable")).toBe(true);
    expect(blocksWork(scoped("Fable 5.2"), "claude-fable-5-2")).toBe(true);
    expect(blocksWork(scoped("Sonnet 5"), "claude-sonnet-5-5")).toBe(true);
    expect(blocksWork(scoped("Sonnet 5"), "sonnet")).toBe(true);
    expect(blocksWork(scoped("GPT-5.3-Codex-Spark"), "gpt-5.3-codex-spark")).toBe(true);
    expect(blocksWork(scoped("Fable"), "claude-opus-5-5")).toBe(false);
    expect(blocksWork(scoped("GPT-5.3-Codex-Spark"), "gpt-5.5")).toBe(false);
  });

  it("isn't a wall for the plan as a whole; spend never is", () => {
    expect(blocksWork(scoped("Fable"))).toBe(false);
    expect(blocksWork(scoped("Fable"), null)).toBe(false);
    expect(blocksWork({ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 100 })).toBe(
      true,
    );
    expect(
      blocksWork(
        { id: "monthly_spend", kind: "monthly", label: "Extra", usedPercent: 100 },
        "claude-opus-5-5",
      ),
    ).toBe(false);
  });

  it("a stop on Opus resumes with the 5-hour limit, not with Fable's week", () => {
    const windows = [
      { id: "five_hour", kind: "session", label: "5-hour", usedPercent: 100, resetsAt: at(90) },
      {
        id: "seven_day_fable",
        kind: "weekly",
        label: "Weekly · Fable",
        usedPercent: 100,
        resetsAt: at(3000),
        scope: "Fable",
      },
    ] as const;
    const resumeAt = (model: string) => {
      const time = planResumeTime({
        account: account({ windows }),
        model,
        stopText: "limit reached",
        now: NOW,
      });
      return time.kind === "at" ? Date.parse(time.resumeAt) : null;
    };
    expect(resumeAt("claude-opus-5-5")).toBe(Date.parse(at(90)) + PLAN_RESUME_GRACE_MS);
    expect(resumeAt("claude-fable-5-1")).toBe(Date.parse(at(3000)) + PLAN_RESUME_GRACE_MS);
  });
});

describe("planAccountForInstance", () => {
  const main = account({ id: "claude:main@b.c" });
  const second = account({ id: "claude:two@b.c", instanceId: "claudeAgent_account_ab12cd34" });
  const chatgpt = account({ id: "chatgpt:x", provider: "chatgpt" });
  const accounts = [second, main, chatgpt];

  it("gives the default instance (or none named) the computer's main sign-in", () => {
    expect(planAccountForInstance(accounts, "claude", "claudeAgent")).toBe(main);
    expect(planAccountForInstance(accounts, "claude", null)).toBe(main);
  });

  it("gives a second account its own row, never the main one instead", () => {
    expect(planAccountForInstance(accounts, "claude", "claudeAgent_account_ab12cd34")).toBe(second);
    expect(planAccountForInstance(accounts, "claude", "claudeAgent_account_gone")).toBeNull();
  });
});

describe("pendingPlanResume", () => {
  const scheduled = (resumeAt: string) => ({
    kind: PLAN_RESUME_SCHEDULED_ACTIVITY,
    payload: { resumeAt },
  });
  const ended = { kind: PLAN_RESUME_ENDED_ACTIVITY, payload: { reason: "person-cancelled" } };
  const other = { kind: "tool.completed", payload: {} };

  it("is the latest schedule", () => {
    expect(pendingPlanResume([scheduled(at(1)), other, scheduled(at(2)), other])).toEqual({
      resumeAt: at(2),
    });
  });

  it("is nothing once something ended it, until the next schedule", () => {
    expect(pendingPlanResume([scheduled(at(1)), ended])).toBeNull();
    expect(pendingPlanResume([scheduled(at(1)), ended, scheduled(at(2))])).toEqual({
      resumeAt: at(2),
    });
    expect(pendingPlanResume([other])).toBeNull();
  });
});

describe("the notes the chat shows for these messages", () => {
  it("speaks to the person, not the agent", () => {
    expect(parseUnoWorkNote(`${UNO_WORK_NOTE_PREFIX}${PLAN_RESUME_NOTE_BODY}`)).toMatchObject({
      kind: "plan-resume",
    });
    expect(parseUnoWorkNote(`${UNO_WORK_NOTE_PREFIX}${ACCOUNT_SWITCH_NOTE_BODY}`)).toMatchObject({
      kind: "plan-resume",
      text: "Continued with your other account.",
    });
  });
});
