import { describe, expect, it } from "vitest";

import { assistantFiles } from "./assistantTemplates";
import {
  planFromHermes,
  quizConsoleNext,
  toggleQuizPick,
  withQuizAnswer,
  type QuizStep,
} from "./assistantQuizApi";

describe("assistant quiz", () => {
  it("an answer goes into a copy of the state, with the follow-up topic", () => {
    const state = { v: 1, lang: "en", answers: { do: { picks: ["reply"] } }, edit: "autonomy" };
    const step = { id: "follow", for: "reply" } as unknown as QuizStep;
    const next = withQuizAnswer(state, step, { picks: ["telegram"] });
    expect(next.answers?.["follow"]).toEqual({ picks: ["telegram"], for: "reply" });
    expect(next.edit).toBe("");
    expect(state.answers).not.toHaveProperty("follow");
  });

  it("Set it up from the light Work: plan step, or straight to Work on a cloud-Work plan", () => {
    const as = "eyJsYW5nIjoiZW4ifQ";
    expect(quizConsoleNext(`/start?path=work&step=plan&goal=assistant&via=uno&as=${as}`)).toBe(
      `/start?path=work&step=plan&goal=assistant&via=uno&as=${as}`,
    );
    expect(quizConsoleNext(`/work?do=assistant&as=${as}`)).toBe(`/work?do=assistant&as=${as}`);
    expect(quizConsoleNext("/work?do=upload")).toBe("/start?goal=assistant");
    expect(quizConsoleNext("https://evil.example/start?x=1")).toBe("/start?goal=assistant");
    expect(quizConsoleNext(`/work?do=assistant&as=${as}&q=<script>`)).toBe("/start?goal=assistant");
    expect(quizConsoleNext(undefined)).toBe("/start?goal=assistant");
  });

  it("tiles toggle, never past max", () => {
    expect(toggleQuizPick([], "code", 3)).toEqual(["code"]);
    expect(toggleQuizPick(["code"], "code", 3)).toEqual([]);
    expect(toggleQuizPick(["a", "b", "c"], "d", 3)).toEqual(["a", "b", "c"]);
  });

  it("hermes from the spec becomes an AssistantPlan, How I work lands in SOUL.md", () => {
    const plan = planFromHermes({
      name: "Uno",
      emoji: "💬",
      template: "support",
      phrase: "Your assistant will answer your customers in Telegram.",
      job: "Reply to people (Telegram)",
      connectors: { gmail: "write", github: "bogus" },
      schedule: { label: "Every morning", cron: "0 9 * * *" },
      answers: [
        {
          questionId: "do",
          question: "What should your assistant do?",
          answer: "Reply to people",
          cron: null,
        },
      ],
      never: ["Pay for anything", "Publish anything without asking first"],
      instructions: "## How I work (set up in the Uno interview)\n- Language: English.",
    });
    expect(plan.template).toBe("support");
    expect(plan.connectors).toEqual({
      gmail: "write",
      "google-drive": "none",
      notion: "none",
      github: "none",
    });
    expect(plan.schedule).toEqual({ label: "Every morning", cron: "0 9 * * *" });
    const files = assistantFiles(plan, "2026-10-05T12:00:00Z");
    expect(files.soul).toContain("## How I work (set up in the Uno interview)");
    expect(files.soul).toContain("Publish anything without asking first");
    expect(files.user).toContain("What should your assistant do? — Reply to people");
  });

  it("an empty hermes still gives a safe plan", () => {
    const plan = planFromHermes({});
    expect(plan.name).toBe("Uno");
    expect(plan.never).toEqual(["Pay for anything"]);
    expect(plan.howIWork).toBeUndefined();
  });
});
