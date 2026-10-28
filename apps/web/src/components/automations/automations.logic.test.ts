import type { Automation, AutomationRun } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  EMPTY_DRAFT,
  autoName,
  automationFromToolResult,
  draftOf,
  draftProblem,
  emptyHint,
  groupByAssistant,
  isRepoName,
  modeLine,
  normalizeRepo,
  runIsActive,
  runLine,
  statusProblem,
  triggerOf,
  unavailableLine,
} from "./automations.logic";

const run = (over: Partial<AutomationRun> = {}): AutomationRun =>
  ({
    id: 1,
    automationId: 1,
    kind: "github.pull_request",
    title: "PR #12 · Fix login",
    url: "https://github.com/getuno/web/pull/12",
    state: "done",
    reason: null,
    threadId: null,
    summary: null,
    createdAt: "2026-10-28T09:00:00Z",
    startedAt: null,
    finishedAt: null,
    ...over,
  }) as AutomationRun;

const automation = (over: Partial<Automation> = {}): Automation =>
  ({
    id: 7,
    boxId: 2601,
    assistant: "assistant-bolt",
    assistantName: "Bolt",
    name: "Review PRs in getuno/web",
    instruction: "Review the PR and leave a comment",
    enabled: true,
    trigger: { kind: "github.pull_request", repo: "getuno/web" },
    status: "ok",
    statusDetail: null,
    manageUrl: "https://github.com/settings/installations/1",
    nextRunAt: null,
    lastRun: null,
    createdAt: "2026-10-28T09:00:00Z",
    updatedAt: "2026-10-28T09:00:00Z",
    ...over,
  }) as Automation;

describe("the last run in words", () => {
  it("says the computer sleeps, honestly", () => {
    expect(runLine(run({ state: "waiting_wake", reason: "computer_asleep" }), "uno-work")).toEqual({
      text: "Waiting — uno-work is asleep, it runs when the computer wakes",
      tone: "wait",
    });
  });

  it("explains skipped, superseded, failed and missed runs", () => {
    expect(runLine(run({ state: "skipped", reason: "limit" }), "x").text).toBe(
      "Skipped — too many runs this hour (12 at most)",
    );
    expect(runLine(run({ state: "superseded", reason: "newer push" }), "x").text).toBe(
      "Skipped — a newer push came, that one ran instead",
    );
    expect(runLine(run({ state: "failed", reason: "GitHub said 403" }), "x")).toEqual({
      text: "Failed: GitHub said 403",
      tone: "error",
    });
    expect(runLine(run({ state: "failed", reason: null }), "x").text).toBe(
      "Failed: it stopped with an error",
    );
    expect(runLine(run({ state: "expired" }), "free-cloud").text).toBe(
      "Missed — free-cloud was off at that time",
    );
  });

  it("knows a run that is still going", () => {
    expect(runIsActive(run({ state: "queued" }))).toBe(true);
    expect(runIsActive(run({ state: "waiting_wake" }))).toBe(true);
    expect(runIsActive(run({ state: "done" }))).toBe(false);
    expect(runIsActive(null)).toBe(false);
  });
});

describe("what's wrong with it", () => {
  it("offers the fix on GitHub", () => {
    expect(statusProblem(automation({ status: "needs_github_repo" }))).toMatchObject({
      text: "Uno's GitHub app can't see getuno/web",
      action: "Add it on GitHub",
      url: "https://github.com/settings/installations/1",
    });
    expect(statusProblem(automation({ status: "needs_github_permission" }))?.action).toBe(
      "Review on GitHub",
    );
    expect(statusProblem(automation({ status: "github_not_connected" }))?.action).toBe(
      "Connect GitHub",
    );
    expect(statusProblem(automation())).toBeNull();
  });

  it("hides the section when the feature is off, explains a laptop", () => {
    expect(unavailableLine("disabled")).toBeNull();
    expect(unavailableLine("not_cloud_computer")).toBe(
      "Automations run on a cloud computer — a laptop sleeps and closes.",
    );
    expect(unavailableLine("console_unreachable")).toMatch(/Try again/);
  });

  it("says the mode and the empty hint plainly", () => {
    expect(modeLine("Ada", true, "github.pull_request")).toBe(
      "Cautious — Ada asks you before commenting",
    );
    expect(modeLine("Ada", false, "github.pull_request")).toBe(
      "Autonomous — Ada comments on its own",
    );
    expect(modeLine("Uno", false, "schedule")).toBe("Autonomous — Uno acts and tells you after");
    expect(emptyHint("Uno")).toContain("every time a PR comes to owner/repo, review it");
  });
});

describe("the dialog's draft", () => {
  it("makes a schedule in the browser's zone", () => {
    expect(
      triggerOf({ ...EMPTY_DRAFT, cadence: "weekly", weekday: 5, time: "17:30" }, "Europe/Berlin"),
    ).toEqual({
      kind: "schedule",
      cron: "30 17 * * 5",
      timezone: "Europe/Berlin",
      label: "Every Friday at 17:30",
    });
    expect(triggerOf({ ...EMPTY_DRAFT, cadence: "hourly", time: "09:15" }, "UTC")).toMatchObject({
      cron: "15 * * * *",
      label: "Every hour at :15",
    });
  });

  it("makes a pull request trigger from a pasted GitHub address", () => {
    expect(
      triggerOf(
        {
          ...EMPTY_DRAFT,
          when: "event",
          source: "github",
          repo: " https://github.com/getuno/web.git ",
        },
        "UTC",
      ),
    ).toMatchObject({ kind: "github.pull_request", repo: "getuno/web", drafts: false });
    expect(normalizeRepo("getuno/web/")).toBe("getuno/web");
    expect(isRepoName("getuno")).toBe(false);
    expect(triggerOf({ ...EMPTY_DRAFT, when: "event", source: "call" }, "UTC")).toEqual({
      kind: "call.ended",
    });
  });

  it("stops Create until it knows enough", () => {
    expect(draftProblem(EMPTY_DRAFT)).toBe("Say what to do.");
    expect(
      draftProblem({ ...EMPTY_DRAFT, when: "event", source: "github", instruction: "Review" }),
    ).toBe("Pick a repository.");
    expect(
      draftProblem({ ...EMPTY_DRAFT, when: "event", source: "gmail", instruction: "x" }),
    ).toMatch(/soon/);
    expect(draftProblem({ ...EMPTY_DRAFT, instruction: "Sum up my day" })).toBeNull();
  });

  it("names it when the person doesn't", () => {
    expect(
      autoName({
        ...EMPTY_DRAFT,
        when: "event",
        source: "github",
        repo: "getuno/web",
        instruction: "Review the PR and leave a comment",
      }),
    ).toBe("Review PRs in getuno/web");
    expect(autoName({ ...EMPTY_DRAFT, instruction: "Sum up my day. Then send it." })).toBe(
      "Sum up my day",
    );
    expect(autoName({ ...EMPTY_DRAFT, when: "event", source: "call" })).toBe("After each call");
  });

  it("reads an automation back for Edit", () => {
    const weekly = automation({
      trigger: {
        kind: "schedule",
        cron: "0 18 * * 1-5",
        timezone: "UTC",
        label: "Weekdays at 18:00",
      },
    });
    expect(draftOf(weekly)).toMatchObject({ when: "schedule", cadence: "weekdays", time: "18:00" });
    expect(
      draftOf(
        automation({
          trigger: { kind: "schedule", cron: "5 9 * * 3", timezone: "UTC", label: "x" },
        }),
      ),
    ).toMatchObject({ cadence: "weekly", weekday: 3, time: "09:05" });
    expect(draftOf(automation())).toMatchObject({
      when: "event",
      source: "github",
      repo: "getuno/web",
      name: "Review PRs in getuno/web",
    });
    // A cron the dialog can't say: weekdays at 09:00, the person sees and can change it.
    expect(
      draftOf(
        automation({
          trigger: { kind: "schedule", cron: "*/5 * * * *", timezone: "UTC", label: "x" },
        }),
      ),
    ).toMatchObject({ cadence: "weekdays", time: "09:00" });
  });
});

describe("the Automations screen and the chat card", () => {
  it("groups by assistant in the team's order, removed ones last", () => {
    const items = [
      {
        environmentId: "w",
        automation: automation({ id: 3, assistant: "assistant-gone", assistantName: "Zed" }),
      },
      { environmentId: "w", automation: automation({ id: 2, assistant: "assistant-bolt" }) },
      {
        environmentId: "w",
        automation: automation({ id: 1, assistant: "assistant-home", assistantName: "Uno" }),
      },
    ];
    const groups = groupByAssistant(items, [
      { environmentId: "w", projectId: "assistant-home" },
      { environmentId: "w", projectId: "assistant-bolt" },
    ]);
    expect(groups.map((group) => group.assistantName)).toEqual(["Uno", "Bolt", "Zed"]);
  });

  it("takes the automation from automation_create's result, or nothing", () => {
    const made = automation();
    expect(automationFromToolResult(JSON.stringify({ automation: made }))?.id).toBe(7);
    expect(automationFromToolResult(JSON.stringify(made))?.name).toBe("Review PRs in getuno/web");
    expect(automationFromToolResult("Created it")).toBeNull();
    expect(automationFromToolResult(JSON.stringify({ error: { code: "X" } }))).toBeNull();
    expect(automationFromToolResult(undefined)).toBeNull();
  });
});
