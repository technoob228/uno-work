import { describe, expect, it } from "vitest";

import { unoScheduleLine } from "./unoSchedules.logic";

const morning = {
  name: "Morning plan",
  cron: "0 9 * * *",
  timezone: "America/Argentina/Buenos_Aires",
  prompt: "Send me a short plan for today.",
  state: "active",
};

describe("unoScheduleLine", () => {
  it("reads like a sentence in the person's own time zone", () => {
    expect(unoScheduleLine(morning, "America/Argentina/Buenos_Aires")).toEqual({
      when: "Every day at 09:00",
      what: "Morning plan",
      paused: false,
    });
  });

  it("names the schedule's city when it isn't the browser's zone", () => {
    expect(unoScheduleLine(morning, "Europe/Berlin").when).toBe(
      "Every day at 09:00 (Buenos Aires time)",
    );
    expect(unoScheduleLine({ ...morning, timezone: null }, "Europe/Berlin").when).toBe(
      "Every day at 09:00 (UTC time)",
    );
  });

  it("falls back to the instruction and says when it is paused", () => {
    const line = unoScheduleLine({ ...morning, name: " ", state: "paused" }, null);
    expect(line.what).toBe("Send me a short plan for today.");
    expect(line.paused).toBe(true);
  });
});
