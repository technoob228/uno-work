import { describe, expect, it } from "vitest";

import { appSpendBreakdown, appUsageLine, taskSpendNote } from "./AppsAiSettingsPanel";

describe("Settings → Apps spending lines", () => {
  it("one limit, and the split once the app gives jobs", () => {
    const app = {
      name: "Digest",
      tasks: true,
      spentUsd: 0.65,
      chatSpentUsd: 0.25,
      tasksSpentUsd: 0.4,
      limitUsd: 1,
    };
    expect(appUsageLine(app)).toBe("Digest used $0.65 of $1");
    expect(appSpendBreakdown(app)).toBe("answers $0.25, jobs $0.40");
    expect(appSpendBreakdown({ tasks: false, chatSpentUsd: 0.1, tasksSpentUsd: 0 })).toBeNull();
  });

  it("says why jobs might not be counted", () => {
    expect(taskSpendNote({ taskSpend: "metered", taskHarnessUsesUnoAi: true })).toBeNull();
    expect(taskSpendNote({ taskSpend: "metered", taskHarnessUsesUnoAi: false })).toContain(
      "subscription",
    );
    expect(taskSpendNote({ taskSpend: "unavailable", taskHarnessUsesUnoAi: true })).toContain(
      "can't report",
    );
  });
});
