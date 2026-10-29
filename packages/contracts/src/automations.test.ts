import { describe, expect, it } from "vitest";

import {
  automationCronFor,
  automationRunsInChat,
  everyLabel,
  weekdaysLabel,
} from "./automations.ts";

describe("automationCronFor (29.10: days and every N)", () => {
  it("picked weekdays", () => {
    expect(automationCronFor({ cadence: "days", time: "09:00", weekdays: [5, 1, 3] })).toEqual({
      cron: "0 9 * * 1,3,5",
      label: "Mon, Wed, Fri at 09:00",
    });
    expect(automationCronFor({ cadence: "days", time: "18:30", weekdays: [0, 6] })).toEqual({
      cron: "30 18 * * 0,6",
      label: "Weekends at 18:30",
    });
    expect(
      automationCronFor({ cadence: "days", time: "07:05", weekdays: [0, 1, 2, 3, 4, 5, 6] }),
    ).toEqual({ cron: "5 7 * * *", label: "Every day at 07:05" });
    expect(automationCronFor({ cadence: "days", time: "09:00", weekdays: [] }).cron).toBe(
      "0 9 * * 1",
    );
  });

  it("every N minutes or hours, never under 15 minutes", () => {
    expect(automationCronFor({ cadence: "every", time: "09:00", everyMinutes: 15 })).toEqual({
      cron: "*/15 * * * *",
      label: "Every 15 minutes",
    });
    expect(automationCronFor({ cadence: "every", time: "09:00", everyMinutes: 5 }).cron).toBe(
      "*/15 * * * *",
    );
    expect(automationCronFor({ cadence: "every", time: "09:10", everyMinutes: 120 })).toEqual({
      cron: "10 */2 * * *",
      label: "Every 2 hours",
    });
    expect(automationCronFor({ cadence: "every", time: "09:00", everyMinutes: 60 })).toEqual({
      cron: "0 * * * *",
      label: "Every hour",
    });
  });

  it("labels", () => {
    expect(everyLabel(30)).toBe("Every 30 minutes");
    expect(everyLabel(720)).toBe("Every 12 hours");
    expect(weekdaysLabel([1, 2, 3, 4, 5])).toBe("Weekdays");
    expect(weekdaysLabel([0, 1])).toBe("Mon, Sun");
  });
});

describe("automationRunsInChat", () => {
  it("its own chat, or a new-chat automation set up from it", () => {
    expect(automationRunsInChat({ executor: { kind: "chat", threadId: "t" } }, "t")).toBe(true);
    expect(automationRunsInChat({ executor: { kind: "chat", threadId: "t" } }, "u")).toBe(false);
    expect(
      automationRunsInChat(
        { executor: { kind: "new_chat", projectId: "p", fromThreadId: "t" } },
        "t",
      ),
    ).toBe(true);
    expect(automationRunsInChat({}, "t")).toBe(false);
  });
});
