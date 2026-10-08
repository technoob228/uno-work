import { describe, expect, it } from "vitest";

import {
  goalFromAccountPath,
  nextStepChatId,
  nextStepDoneKey,
  nextStepSkipKey,
  parseNextStepPlan,
  visibleNextStep,
  withoutSshFirst,
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

describe("nextStepChatId", () => {
  const resume = { botChatId: "bot1", siteChatId: "site1", lastChatId: "last1" };

  it("opens the chat about the same thing, else the newest one", () => {
    expect(nextStepChatId("describe_bot", resume)).toBe("bot1");
    expect(nextStepChatId("describe_site", resume)).toBe("site1");
    expect(nextStepChatId("talk_to_uno", resume)).toBe("last1");
    expect(nextStepChatId("describe_bot", { ...resume, botChatId: null })).toBe("last1");
    expect(nextStepChatId("describe_site", { ...resume, siteChatId: null })).toBe("last1");
  });

  it("a new chat when nothing was started, and for steps that are not a chat", () => {
    expect(
      nextStepChatId("describe_bot", { botChatId: null, siteChatId: null, lastChatId: null }),
    ).toBeNull();
    expect(nextStepChatId("describe_bot", null)).toBeNull();
    expect(nextStepChatId("get_computer", resume)).toBeNull();
    expect(nextStepChatId("connect_ssh", resume)).toBeNull();
  });
});

describe("withoutSshFirst", () => {
  const server = (source: string) =>
    parseNextStepPlan({
      version: 1,
      goal: "server",
      goal_source: source,
      next: { id: "connect_ssh", title: "Connect with SSH or your agent" },
      steps: [
        { id: "create_computer", title: "Start your server", done: true },
        { id: "connect_ssh", title: "Connect with SSH or your agent", done: false },
        { id: "install_app", title: "Put your first app on it", done: false },
      ],
      signals: {},
    });

  it("a guessed goal: SSH goes under the card, the next step leads", () => {
    const plan = server("guessed");
    const result = withoutSshFirst(plan, visibleNextStep(plan, {}), {}, false);
    expect(result.step?.id).toBe("install_app");
    expect(result.developerStep?.id).toBe("connect_ssh");
  });

  it("a person who picked the server goal, or has Dev mode on, sees SSH first", () => {
    const picked = server("console");
    expect(withoutSshFirst(picked, visibleNextStep(picked, {}), {}, false)).toMatchObject({
      step: { id: "connect_ssh" },
      developerStep: null,
    });
    const guessed = server("guessed");
    expect(withoutSshFirst(guessed, visibleNextStep(guessed, {}), {}, true)).toMatchObject({
      step: { id: "connect_ssh" },
      developerStep: null,
    });
  });

  it("nothing after SSH, or the next one put off: no card", () => {
    const plan = server("guessed");
    const answers = { [nextStepSkipKey("install_app")]: "x" };
    expect(withoutSshFirst(plan, visibleNextStep(plan, answers), answers, false).step).toBeNull();
  });

  it("other steps are left alone", () => {
    const plan = server("guessed");
    const other = { id: "install_app", title: "", hint: null, done: false, consolePath: null };
    expect(withoutSshFirst(plan, other, {}, false)).toEqual({ step: other, developerStep: null });
  });
});
