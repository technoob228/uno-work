import { describe, expect, it } from "vitest";

import {
  goalFromAccountPath,
  nextStepDoneKey,
  nextStepSkipKey,
  parseNextStepPlan,
  visibleNextStep,
} from "./nextStep";

describe("goalFromAccountPath", () => {
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
  const step = (id: string, done = false) => ({ id, title: id, done, console_path: "/work" });
  const assistant = parseNextStepPlan({
    version: 1,
    goal: "assistant",
    goal_source: "console",
    stage: "first_result",
    next: { id: "morning_plan", title: "Morning plan", console_path: "/work" },
    steps: [step("talk_to_uno", true), step("connect_telegram", true), step("morning_plan")],
    signals: { ai_available: true },
  });

  it("shows the backend's next step as is", () => {
    const plan = parseNextStepPlan({
      version: 1,
      goal: "bot",
      goal_source: "console",
      stage: "first_result",
      // A rule on the backend may pick a step that isn't the first open one.
      next: { id: "get_computer", title: "Get a computer", console_path: "/billing?tab=plan" },
      steps: [step("describe_bot", true), step("bot_save_orders"), step("get_computer")],
      signals: {},
    });
    expect(visibleNextStep(plan, {})?.id).toBe("get_computer");
  });

  it("an id Work doesn't know still shows", () => {
    const plan = parseNextStepPlan({
      version: 1,
      goal: "site",
      next: { id: "brand_new_step", title: "New", console_path: "/x" },
      steps: [],
      signals: {},
    });
    expect(visibleNextStep(plan, {})?.title).toBe("New");
  });

  it("nothing to push, no answer — no card", () => {
    expect(visibleNextStep(null, {})).toBeNull();
    expect(
      visibleNextStep(
        parseNextStepPlan({ version: 1, next: null, steps: [step("a", true)], signals: {} }),
        {},
      ),
    ).toBeNull();
  });

  it("'Not now' hides the card, it doesn't jump ahead", () => {
    expect(visibleNextStep(assistant, { [nextStepSkipKey("morning_plan")]: "x" })).toBeNull();
  });

  it("an idea taken here moves on before the account catches up", () => {
    expect(visibleNextStep(assistant, { [nextStepDoneKey("morning_plan")]: "x" })).toBeNull();
  });
});
