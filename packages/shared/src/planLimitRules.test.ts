import type { PlanLimitsAccount } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_SWITCH_NOTE_BODY,
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
      planResumeTime({ account: null, stopText: "You've hit your usage limit.", now: NOW }),
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
        stopText: "limit",
        now: NOW,
      }),
    ).toEqual({ kind: "too-far" });
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
