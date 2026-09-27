import { describe, expect, it } from "vitest";

import {
  aiAvailableFrom,
  goalFromAccountPath,
  guessGoal,
  nextStepDoneKey,
  nextStepSkipKey,
  parseNextStepPlan,
  planNextStep,
  visibleNextStep,
  type NextStepSignals,
} from "./nextStep";

const signals = (over: Partial<NextStepSignals> = {}): NextStepSignals => ({
  aiAvailable: true,
  aiHoursLeftMinutes: 120,
  ownAi: false,
  hasPlan: true,
  plan: "small",
  computers: 1,
  hasWorkComputer: true,
  sites: 0,
  formsConfigured: null,
  agentKeyCreated: false,
  agentConnected: false,
  telegramLinked: false,
  sshKeys: 0,
  firstResultGoal: null,
  ideasDone: [],
  ...over,
});

const picked = (goal: Parameters<typeof planNextStep>[0]["goal"]) =>
  ({ goal, goalSource: "console" }) as const;

describe("planNextStep", () => {
  it("own agent: connect first (Rama 26.09), then a site, then a computer", () => {
    expect(planNextStep(picked("own_agent"), signals()).next?.id).toBe("connect_agent");
    const connected = planNextStep(picked("own_agent"), signals({ agentConnected: true }));
    expect(connected.next?.id).toBe("agent_publish_site");
    expect(connected.stage).toBe("first_result");
    const all = planNextStep(
      picked("own_agent"),
      signals({ agentConnected: true, sites: 1, computers: 1 }),
    );
    expect(all.next).toBeNull();
    expect(all.stage).toBe("growing");
  });

  it("assistant without AI: turn AI on first, never 'talk' or 'Telegram'", () => {
    const plan = planNextStep(picked("assistant"), signals({ aiAvailable: false }));
    expect(plan.next?.id).toBe("get_ai_hours");
    expect(plan.steps.map((step) => step.id).slice(0, 2)).toEqual(["get_ai_hours", "talk_to_uno"]);
  });

  it("assistant with AI: talk to Uno, then Telegram, then the morning plan idea", () => {
    expect(planNextStep(picked("assistant"), signals()).next?.id).toBe("talk_to_uno");
    expect(
      planNextStep(picked("assistant"), signals({ firstResultGoal: "assistant" })).next?.id,
    ).toBe("connect_telegram");
    expect(
      planNextStep(
        picked("assistant"),
        signals({ firstResultGoal: "assistant", telegramLinked: true }),
      ).next?.id,
    ).toBe("morning_plan");
  });

  it("site: describe it, then a form", () => {
    expect(planNextStep(picked("site"), signals()).next?.id).toBe("describe_site");
    expect(planNextStep(picked("site"), signals({ sites: 1 })).next?.id).toBe("site_add_form");
    expect(
      planNextStep(picked("site"), signals({ sites: 1, formsConfigured: true })).next,
    ).toBeNull();
  });

  it("bot: a plan only when there's no computer to run it", () => {
    expect(planNextStep(picked("bot"), signals({ computers: 0 })).next?.id).toBe("get_computer");
    const onComputer = planNextStep(picked("bot"), signals());
    expect(onComputer.next?.id).toBe("describe_bot");
    expect(onComputer.steps.some((step) => step.id === "get_computer")).toBe(false);
  });

  it("server: start it, connect, first app", () => {
    expect(planNextStep(picked("server"), signals({ computers: 0 })).next?.id).toBe(
      "create_computer",
    );
    expect(planNextStep(picked("server"), signals()).next?.id).toBe("connect_ssh");
    expect(planNextStep(picked("server"), signals({ sshKeys: 1 })).next?.id).toBe("install_app");
  });

  it("no goal: guessed from the account, else 'pick a goal'", () => {
    const guessed = planNextStep({ goal: null, goalSource: "none" }, signals({ sites: 2 }));
    expect(guessed.goal).toBe("site");
    expect(guessed.goalSource).toBe("guessed");
    const none = planNextStep(
      { goal: null, goalSource: "none" },
      signals({ computers: 0, hasWorkComputer: false }),
    );
    expect(none.goalSource).toBe("none");
    expect(none.next?.id).toBe("pick_goal");
  });
});

describe("guessGoal / goalFromAccountPath", () => {
  it("prefers an agent key, then sites, then a Work computer, then any computer", () => {
    expect(guessGoal(signals({ agentKeyCreated: true, sites: 3 }))).toBe("own_agent");
    expect(guessGoal(signals({ sites: 1 }))).toBe("site");
    expect(guessGoal(signals())).toBe("assistant");
    expect(guessGoal(signals({ hasWorkComputer: false }))).toBe("server");
    expect(guessGoal(signals({ hasWorkComputer: false, computers: 0 }))).toBeNull();
  });

  it("maps the console's v2 paths", () => {
    expect(goalFromAccountPath("agent")).toBe("own_agent");
    expect(goalFromAccountPath("hardware")).toBe("own_agent");
    expect(goalFromAccountPath("host")).toBe("site");
    expect(goalFromAccountPath("computer")).toBe("server");
    expect(goalFromAccountPath("work")).toBe("assistant");
    expect(goalFromAccountPath("bot")).toBe("bot");
    expect(goalFromAccountPath("nope")).toBeNull();
    expect(goalFromAccountPath(null)).toBeNull();
  });
});

describe("parseNextStepPlan", () => {
  it("reads the backend's v1 answer", () => {
    const plan = parseNextStepPlan({
      version: 1,
      goal: "own_agent",
      goal_source: "console",
      stage: "start",
      next: {
        id: "connect_agent",
        title: "Connect",
        hint: "h",
        console_path: "/access?give=agent",
      },
      steps: [
        { id: "connect_agent", title: "Connect", done: false, console_path: "/access?give=agent" },
        { id: "agent_publish_site", title: "Publish", done: true, optional: true },
        { title: "no id" },
      ],
      signals: { ai_available: false },
    });
    expect(plan?.source).toBe("backend");
    expect(plan?.goal).toBe("own_agent");
    expect(plan?.next?.consolePath).toBe("/access?give=agent");
    expect(plan?.steps.map((step) => step.id)).toEqual(["connect_agent", "agent_publish_site"]);
    expect(plan?.aiAvailable).toBe(false);
  });

  it("rejects other versions and junk", () => {
    expect(parseNextStepPlan({ version: 2 })).toBeNull();
    expect(parseNextStepPlan("404 page not found")).toBeNull();
    expect(parseNextStepPlan(null)).toBeNull();
  });
});

describe("visibleNextStep", () => {
  const plan = planNextStep(picked("site"), signals());

  it("shows the first step not done", () => {
    expect(visibleNextStep(plan, {})?.id).toBe("describe_site");
  });

  it("'Not now' hides the card, it doesn't jump ahead", () => {
    expect(visibleNextStep(plan, { [nextStepSkipKey("describe_site")]: "x" })).toBeNull();
  });

  it("an idea taken here moves on", () => {
    const assistant = planNextStep(
      picked("assistant"),
      signals({ firstResultGoal: "assistant", telegramLinked: true }),
    );
    expect(visibleNextStep(assistant, { [nextStepDoneKey("morning_plan")]: "x" })).toBeNull();
  });
});

describe("aiAvailableFrom", () => {
  it("zero hours is 'no AI'; unknown, unlimited or no pool is not", () => {
    expect(aiAvailableFrom({ status: "ok", hoursLeftMinutes: 0, unlimited: false })).toBe(false);
    expect(aiAvailableFrom({ status: "ok", hoursLeftMinutes: 0, unlimited: true })).toBe(true);
    expect(aiAvailableFrom({ status: "ok", hoursLeftMinutes: null, unlimited: false })).toBe(true);
    expect(aiAvailableFrom({ status: "unavailable", hoursLeftMinutes: 0, unlimited: false })).toBe(
      true,
    );
    expect(aiAvailableFrom(null)).toBe(true);
  });
});
