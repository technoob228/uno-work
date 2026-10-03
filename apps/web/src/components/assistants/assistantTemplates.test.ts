import { describe, expect, it } from "vitest";

import {
  assistantBoxName,
  assistantFiles,
  assistantStatus,
  assistantTurnCommand,
  buildPlan,
  connectorsFromPhrase,
  describeCron,
  fallbackDraft,
  findTemplate,
  memoryItems,
  promptFromCommand,
  scheduleFromPhrase,
  willDo,
  withoutMemoryLine,
  workspaceFromCommand,
  wontDo,
} from "./assistantTemplates";

describe("templates", () => {
  it("follow the contract's connector table", () => {
    expect(findTemplate("personal")?.connectors).toEqual({
      gmail: "write",
      "google-drive": "write",
      notion: "none",
      github: "none",
    });
    expect(findTemplate("marketing")?.connectors).toEqual({
      gmail: "none",
      "google-drive": "write",
      notion: "write",
      github: "none",
    });
    expect(findTemplate("security")?.connectors).toEqual({
      gmail: "none",
      "google-drive": "none",
      notion: "none",
      github: "read",
    });
    expect(findTemplate("support")?.connectors).toEqual({
      gmail: "write",
      "google-drive": "none",
      notion: "read",
      github: "none",
    });
  });

  it("ask at most three questions each", () => {
    for (const id of ["personal", "marketing", "security", "support"]) {
      expect(findTemplate(id)!.questions.length).toBeLessThanOrEqual(3);
    }
  });
});

describe("a sentence without a template", () => {
  it("opens only the apps it names", () => {
    expect(connectorsFromPhrase("Sort my inbox and put notes into Notion")).toEqual({
      gmail: "write",
      "google-drive": "none",
      notion: "write",
      github: "none",
    });
  });

  it("finds a schedule in plain words and doesn't ask about it again", () => {
    expect(scheduleFromPhrase("send me a report every Monday")).toEqual({
      label: "Every Monday",
      cron: "0 10 * * 1",
    });
    const draft = fallbackDraft("Summarise the news every morning", null);
    expect(draft.schedule?.cron).toBe("0 9 * * *");
    expect(draft.questions.every((q) => q.options.every((o) => !o.cron))).toBe(true);
  });
});

describe("buildPlan", () => {
  const template = findTemplate("marketing")!;
  const draft = fallbackDraft(template.phrase, template);

  it("takes the schedule from a picked option", () => {
    const plan = buildPlan({
      phrase: template.phrase,
      template,
      draft,
      answers: [
        {
          questionId: "how_often",
          question: "How often?",
          answer: "Twice a week",
          cron: "0 10 * * 1,4",
        },
      ],
    });
    expect(plan.schedule).toEqual({ label: "Twice a week", cron: "0 10 * * 1,4" });
    expect(willDo(plan)).toContain("Works on its own: twice a week");
    expect(wontDo(plan)).toContain("Open your Gmail and Calendar");
    expect(wontDo(plan)).toContain("Touch your servers");
  });

  it("drops the schedule when the person picked 'only when I ask'", () => {
    const security = findTemplate("security")!;
    const plan = buildPlan({
      phrase: "Watch my repos every day",
      template: security,
      draft: {
        ...fallbackDraft("x", security),
        schedule: { label: "Every day", cron: "0 8 * * *" },
      },
      answers: [
        { questionId: "how_often", question: "How often?", answer: "Only when I ask", cron: null },
      ],
    });
    expect(plan.schedule).toBeNull();
  });
});

describe("files", () => {
  it("write who it is, its access and the person's words", () => {
    const template = findTemplate("support")!;
    const plan = buildPlan({
      phrase: template.phrase,
      template,
      draft: fallbackDraft(template.phrase, template),
      answers: [{ questionId: "tone", question: "Tone?", answer: "Formal", cron: null }],
    });
    const files = assistantFiles(plan, "2026-10-02T10:00:00Z");
    expect(files.soul).toContain("I am Lu 💬, customer support.");
    expect(files.soul).toContain("Notion: read only");
    expect(files.soul).toContain("Promise refunds or discounts");
    expect(files.user).toContain("Tone? — Formal");
    expect(files.notes).toContain("2026-10-02: created");
  });
});

describe("memory items", () => {
  it("lists bullets and removes one by line", () => {
    const content = "# Notes\n\n- likes tea\n- works Mondays\ntext";
    const items = memoryItems(content);
    expect(items).toEqual([
      { line: 2, text: "likes tea" },
      { line: 3, text: "works Mondays" },
    ]);
    expect(withoutMemoryLine(content, 2)).toBe("# Notes\n\n- works Mondays\ntext");
  });
});

describe("schedules", () => {
  it("quote the prompt for sh and read it back", () => {
    const command = assistantTurnCommand("Send Ana's   report");
    expect(command).toBe("uno-work assistant-turn --prompt 'Send Ana'\\''s report'");
    expect(promptFromCommand(command)).toBe("Send Ana's report");
    expect(promptFromCommand("echo hi")).toBeNull();
  });

  it("describe common crons in words", () => {
    expect(describeCron("0 10 * * 1")).toBe("Every Monday at 10:00");
    expect(describeCron("30 9 * * *")).toBe("Every day at 09:30");
    expect(describeCron("0 10 * * 1-5")).toBe("Every weekday at 10:00");
    expect(describeCron("*/5 * * * *")).toBe("*/5 * * * *");
  });
});

describe("assistantBoxName", () => {
  it("is DNS-ish with a suffix", () => {
    expect(assistantBoxName("Ана Mária!", () => 0)).toBe("assistant-maria-0000");
    expect(assistantBoxName("Ана", () => 0)).toBe("assistant-helper-0000");
  });
});

describe("assistantStatus", () => {
  const idle = { hasPendingApprovals: false, hasPendingUserInput: false, session: null };
  it("puts 'waiting for you' first", () => {
    expect(
      assistantStatus({
        boxStatus: "sleeping",
        threads: [{ ...idle, hasPendingUserInput: true }],
      }),
    ).toBe("waiting");
    expect(
      assistantStatus({
        boxStatus: "running",
        threads: [{ ...idle, session: { status: "running" } }],
      }),
    ).toBe("working");
    expect(assistantStatus({ boxStatus: "hibernated", threads: [] })).toBe("asleep");
    expect(assistantStatus({ boxStatus: "running", threads: [idle] })).toBe("awake");
    expect(assistantStatus({ boxStatus: "creating", threads: [] })).toBe("starting");
  });
});

describe("schedules of an assistant that shares its computer", () => {
  it("names its folder and reads back both forms", () => {
    const command = assistantTurnCommand("Check mail", "/home/u/UnoWork/Assistants/ana");
    expect(command).toBe(
      "uno-work assistant-turn --workspace '/home/u/UnoWork/Assistants/ana' --prompt 'Check mail'",
    );
    expect(workspaceFromCommand(command)).toBe("/home/u/UnoWork/Assistants/ana");
    expect(promptFromCommand(command)).toBe("Check mail");
    // What the assistant's own schedule_create writes.
    expect(
      promptFromCommand(
        "uno-work assistant-turn --workspace '/w' --name 'Digest' --timeout-sec 600 --prompt 'It''s Monday'".replace(
          "It''s",
          "It'\\''s",
        ),
      ),
    ).toBe("It's Monday");
    expect(workspaceFromCommand(assistantTurnCommand("x"))).toBeNull();
  });
});
