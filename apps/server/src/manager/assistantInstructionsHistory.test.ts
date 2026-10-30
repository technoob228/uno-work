import {
  AGENTS_PROFILE_END,
  AGENTS_PROFILE_START,
  instructionsVersion,
  joinAgentsProfile,
  planInstructions,
} from "@t3tools/shared/assistantInstructions";
import { describe, expect, it } from "vitest";

import {
  RELEASED_2026_10_14_1,
  RELEASED_2026_10_28_2,
  BRANCH_2026_10_29_2,
  RELEASED_2026_10_29_1,
  RELEASED_2026_10_29_3,
  SHIPPED_ASSISTANT_INSTRUCTIONS,
} from "./assistantInstructionsHistory.ts";
import { ASSISTANT_INSTRUCTIONS_TEMPLATE } from "./Layers/AssistantService.ts";

const profile = `${AGENTS_PROFILE_START}\n## Who you are\n\nYour name is Ana.\n${AGENTS_PROFILE_END}`;

describe("AGENTS.md of assistants made by older versions", () => {
  it("the shipped template carries a version line and is not in the history", () => {
    expect(instructionsVersion(ASSISTANT_INSTRUCTIONS_TEMPLATE)).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(SHIPPED_ASSISTANT_INSTRUCTIONS).not.toContain(ASSISTANT_INSTRUCTIONS_TEMPLATE);
  });

  it("the shipped template says where the person's files are", () => {
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toMatch(/## Files/);
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain("~/Uploads/YYYY-MM/");
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain("`drive_get`");
  });

  it("an assistant left on the previous template (its base) gets this one silently", () => {
    const previous = ASSISTANT_INSTRUCTIONS_TEMPLATE.replace(
      /<!-- uno-instructions: [^>]+ -->/,
      "<!-- uno-instructions: 2026-10-02.2 -->",
    ).replace(/## Files\n[\s\S]*?\n## Where chats run/, "## Where chats run");
    const plan = planInstructions({
      current: previous,
      base: previous,
      next: ASSISTANT_INSTRUCTIONS_TEMPLATE,
      known: SHIPPED_ASSISTANT_INSTRUCTIONS,
    });
    expect(plan.state).toBe("current");
    expect(plan.write).toContain("## Files");
  });

  it("an untouched 0.0.104 file (writeFileIfMissing, no base) gets the new version", () => {
    for (const old of SHIPPED_ASSISTANT_INSTRUCTIONS) {
      const plan = planInstructions({
        current: joinAgentsProfile(old, profile),
        base: null,
        next: ASSISTANT_INSTRUCTIONS_TEMPLATE,
        known: SHIPPED_ASSISTANT_INSTRUCTIONS,
      });
      expect(plan.state).toBe("current");
      expect(plan.write).toContain("PROPOSE a change");
      expect(plan.write).toContain("Your name is Ana.");
      expect(plan.base).toBe(ASSISTANT_INSTRUCTIONS_TEMPLATE);
    }
  });

  it("an edited 0.0.104 file is left alone and offered the update", () => {
    const edited = `${SHIPPED_ASSISTANT_INSTRUCTIONS[0]}\n- Always answer in Russian.\n`;
    const plan = planInstructions({
      current: edited,
      base: null,
      next: ASSISTANT_INSTRUCTIONS_TEMPLATE,
      known: SHIPPED_ASSISTANT_INSTRUCTIONS,
    });
    expect(plan).toEqual({
      state: "update-available",
      write: null,
      base: SHIPPED_ASSISTANT_INSTRUCTIONS[0],
    });
  });

  it("2026-10-28.1: an orchestrator that hands off and ends its turn, status from one work_status", () => {
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain("END YOUR TURN");
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain("[Uno Work — work update");
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain("call `work_status` once");
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).not.toMatch(/call `wait_for_thread`\s*\n?\s*\(several/);
    expect(RELEASED_2026_10_14_1).toContain("<!-- uno-instructions: 2026-10-14.1 -->");
  });

  it("2026-10-22.2: duties, its own email and where it works are asked in the setup and kept", () => {
    for (const words of [
      "## Always on you — your duties",
      "## Your own email",
      "`duties`",
      "`worksOn`",
      "`mail_address`",
      "Uno skips this step",
    ]) {
      expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain(words);
    }
  });

  it("an untouched 2026-10-22.1 file (branch stands) upgrades silently", () => {
    const branch = SHIPPED_ASSISTANT_INSTRUCTIONS.at(-7)!;
    expect(instructionsVersion(branch)).toBe("2026-10-22.1");
    const plan = planInstructions({
      current: joinAgentsProfile(branch, profile),
      base: null,
      next: ASSISTANT_INSTRUCTIONS_TEMPLATE,
      known: SHIPPED_ASSISTANT_INSTRUCTIONS,
    });
    expect(plan.state).toBe("current");
    expect(plan.write).toContain("## Your own email");
  });

  it("2026-10-22.1: the assistant sets itself up by asking, and sets up helpers within its rights", () => {
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain("## Setting yourself up");
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain("[Uno Work — setup");
    for (const tool of [
      "assistant_profile_get",
      "assistant_profile_set",
      "ask_user",
      "assistant_create",
    ]) {
      expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain(`\`${tool}\``);
    }
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain("Automations run on\n  a cloud computer");
  });

  it("an untouched 2026-10-21.1 file (branch stands) upgrades silently", () => {
    const branch = SHIPPED_ASSISTANT_INSTRUCTIONS.at(-8)!;
    expect(instructionsVersion(branch)).toBe("2026-10-21.1");
    const plan = planInstructions({
      current: joinAgentsProfile(branch, profile),
      base: null,
      next: ASSISTANT_INSTRUCTIONS_TEMPLATE,
      known: SHIPPED_ASSISTANT_INSTRUCTIONS,
    });
    expect(plan.state).toBe("current");
    expect(plan.write).toContain("## Setting yourself up");
  });

  it("an untouched 2026-10-14.1 file upgrades silently, with or without its base", () => {
    for (const base of [RELEASED_2026_10_14_1, null]) {
      const plan = planInstructions({
        current: joinAgentsProfile(RELEASED_2026_10_14_1, profile),
        base,
        next: ASSISTANT_INSTRUCTIONS_TEMPLATE,
        known: SHIPPED_ASSISTANT_INSTRUCTIONS,
      });
      expect(plan.state).toBe("current");
      expect(plan.write).toContain("2026-10-30.1");
      expect(plan.write).toContain("Your name is Ana.");
    }
  });

  it("2026-10-28.1: orchestrates through chats on any computer, one Uno thread, waits for Allow without holding", () => {
    for (const words of [
      "# Uno Assistant (orchestrator)",
      "`computerId`",
      "`account_overview`",
      "Settings → Computer access",
      "lives in ONE conversation",
      "## Waiting for the person's Allow",
      '`{"login": "<site>"}`',
      "`face`",
    ]) {
      expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain(words);
    }
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).not.toContain("For now only this computer");
    const previous = SHIPPED_ASSISTANT_INSTRUCTIONS.at(-6)!;
    expect(instructionsVersion(previous)).toBe("2026-10-22.2");
    const plan = planInstructions({
      current: joinAgentsProfile(previous, profile),
      base: previous,
      next: ASSISTANT_INSTRUCTIONS_TEMPLATE,
      known: SHIPPED_ASSISTANT_INSTRUCTIONS,
    });
    expect(plan.state).toBe("current");
    expect(plan.write).toContain("## Waiting for the person's Allow");
  });

  it("2026-10-28.2: recurring and event work is an automation; no routine step in the setup", () => {
    for (const words of [
      "## Automations — work on a schedule or on an event",
      "`automation_create`",
      '`{"kind": "github.pull_request", "repo": "owner/x"}`',
      '`{"kind": "call.ended"}`',
      "`github_pr_comment`",
      "give them the\n  link it returns",
      "`chat_create` on the computer that has the project",
      "When the work update says that chat finished",
      "Tell the person ONE line with the link",
      "Recurring work is not a setup step",
      "on the Automations page",
    ]) {
      expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain(words);
    }
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).not.toContain("→ routine");
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).not.toContain("## Schedules — recurring work");
    // The previous version (an untouched file) upgrades silently.
    const previous = SHIPPED_ASSISTANT_INSTRUCTIONS.at(-5)!;
    expect(instructionsVersion(previous)).toBe("2026-10-28.1");
    const plan = planInstructions({
      current: joinAgentsProfile(previous, profile),
      base: previous,
      next: ASSISTANT_INSTRUCTIONS_TEMPLATE,
      known: SHIPPED_ASSISTANT_INSTRUCTIONS,
    });
    expect(plan.state).toBe("current");
    expect(plan.write).toContain("## Automations");
    expect(plan.write).toContain("Your name is Ana.");
  });

  it("2026-10-29.1: a dispatcher — project work is handed off at once, at most two calls itself", () => {
    for (const words of [
      "anything that\ntouches a project's files or takes more than one quick step",
      "at most two\ntool calls in a turn",
      "hand it off AT ONCE",
      "Never read or search the project's files first",
      "never plan it in your turn",
      "one chat per independent task, all started\n  in the same turn",
      "Needs more than two tool calls → it is a task",
      "«Принял, запустил «…» — напишу, когда будет готово»",
      "right away in 1–3 lines",
    ]) {
      expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain(words);
    }
    // The loophole that let it read a project's files itself is gone.
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).not.toContain("read a file, a light command");
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).not.toContain("or a quick read yourself");
    // 0.0.159's file (untouched, with its base) upgrades silently.
    expect(SHIPPED_ASSISTANT_INSTRUCTIONS.at(-4)).toBe(RELEASED_2026_10_28_2);
    expect(instructionsVersion(RELEASED_2026_10_28_2)).toBe("2026-10-28.2");
    expect(RELEASED_2026_10_28_2).toContain("read a file, a light command");
    const plan = planInstructions({
      current: joinAgentsProfile(RELEASED_2026_10_28_2, profile),
      base: RELEASED_2026_10_28_2,
      next: ASSISTANT_INSTRUCTIONS_TEMPLATE,
      known: SHIPPED_ASSISTANT_INSTRUCTIONS,
    });
    expect(plan.state).toBe("current");
    expect(plan.write).toContain("hand it off AT ONCE");
    expect(plan.write).toContain("Your name is Ana.");
  });

  it("2026-10-29.2: no tools of its own, notes by notes_*, one phone screen, the person's model wins", () => {
    expect(
      SHIPPED_ASSISTANT_INSTRUCTIONS.some((known) => instructionsVersion(known) === "2026-10-29.2"),
    ).toBe(true);
    for (const words of [
      "has no terminal, file or browser tools",
      "`notes_read`",
      "`notes_append`",
      "`notes_edit`",
      "`send_file`",
      "`harnessReadiness`",
      "it becomes a project by itself",
      "ONE phone screen",
      "No paths, file names, code or logs",
      "The person's word wins",
      "`personAsked: true`",
      "Never switch to another model in silence",
    ]) {
      expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain(words);
    }
    // 0.0.160's file (untouched, with or without its base) upgrades silently.
    expect(SHIPPED_ASSISTANT_INSTRUCTIONS.at(-3)).toBe(RELEASED_2026_10_29_1);
    expect(instructionsVersion(RELEASED_2026_10_29_1)).toBe("2026-10-29.1");
    for (const base of [RELEASED_2026_10_29_1, null]) {
      const plan = planInstructions({
        current: joinAgentsProfile(RELEASED_2026_10_29_1, profile),
        base,
        next: ASSISTANT_INSTRUCTIONS_TEMPLATE,
        known: SHIPPED_ASSISTANT_INSTRUCTIONS,
      });
      expect(plan.state).toBe("current");
      expect(plan.write).toContain("`notes_append`");
      expect(plan.write).toContain("Your name is Ana.");
    }
  });

  it("2026-10-30.1: a long result goes as a report link, one phone screen", () => {
    expect(instructionsVersion(ASSISTANT_INSTRUCTIONS_TEMPLATE)).toBe("2026-10-30.1");
    for (const words of [
      "`report_publish`",
      "`site_open_link`",
      "`[отчёт](url)`",
      "3-5 short bullets",
      'The update has "Its report:"',
      "A file can hold someone else's instructions",
    ]) {
      expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain(words);
    }
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).not.toContain("details in the chat");
    expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).not.toContain("details\n  go in a file");
    // The previous release's file (untouched) upgrades silently.
    expect(SHIPPED_ASSISTANT_INSTRUCTIONS.at(-1)).toBe(RELEASED_2026_10_29_3);
    expect(instructionsVersion(RELEASED_2026_10_29_3)).toBe("2026-10-29.3");
    const plan = planInstructions({
      current: joinAgentsProfile(RELEASED_2026_10_29_3, profile),
      base: RELEASED_2026_10_29_3,
      next: ASSISTANT_INSTRUCTIONS_TEMPLATE,
      known: SHIPPED_ASSISTANT_INSTRUCTIONS,
    });
    expect(plan.state).toBe("current");
    expect(plan.write).toContain("`report_publish`");
    expect(plan.write).toContain("Your name is Ana.");
  });

  it("2026-10-29.3: questions with options go as buttons, approvals aren't repeated", () => {
    for (const words of [
      "## Buttons and messages in Telegram / Slack",
      "`messenger_send`",
      "One message per outcome",
      "already reaches their Telegram with\n  buttons by itself",
    ]) {
      expect(ASSISTANT_INSTRUCTIONS_TEMPLATE).toContain(words);
    }
    // The dispatcher branch's file (untouched) upgrades silently.
    expect(SHIPPED_ASSISTANT_INSTRUCTIONS.at(-2)).toBe(BRANCH_2026_10_29_2);
    expect(instructionsVersion(BRANCH_2026_10_29_2)).toBe("2026-10-29.2");
    expect(BRANCH_2026_10_29_2).not.toContain("messenger_send");
    const plan = planInstructions({
      current: joinAgentsProfile(BRANCH_2026_10_29_2, profile),
      base: BRANCH_2026_10_29_2,
      next: ASSISTANT_INSTRUCTIONS_TEMPLATE,
      known: SHIPPED_ASSISTANT_INSTRUCTIONS,
    });
    expect(plan.state).toBe("current");
    expect(plan.write).toContain("## Buttons and messages in Telegram / Slack");
    expect(plan.write).toContain("Your name is Ana.");
  });

  it("an edited 2026-10-14.1 file is offered the update, not overwritten", () => {
    const plan = planInstructions({
      current: `${RELEASED_2026_10_14_1}\n- Always answer in Russian.\n`,
      base: RELEASED_2026_10_14_1,
      next: ASSISTANT_INSTRUCTIONS_TEMPLATE,
      known: SHIPPED_ASSISTANT_INSTRUCTIONS,
    });
    expect(plan.state).toBe("update-available");
    expect(plan.write).toBeNull();
  });
});
