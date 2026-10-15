import { describe, expect, it } from "vitest";

import { parseNotificationMode, shouldNotify, systemNotificationBody } from "./systemNotifications";

describe("what a notification says", () => {
  it("an approval asks for the OK, with the command", () => {
    expect(systemNotificationBody("agent.approval", "Waits for your OK: rm -rf dist")).toBe(
      "Needs your OK: rm -rf dist",
    );
    expect(systemNotificationBody("agent.approval", "Waits for your OK.")).toBe("Needs your OK.");
    expect(systemNotificationBody("agent.approval", null)).toBe("Needs your OK.");
    expect(systemNotificationBody("agent.approval", "Publish the site")).toBe(
      "Needs your OK: Publish the site",
    );
  });

  it("a question says it asked, with the question", () => {
    expect(systemNotificationBody("agent.input", "Asks: Which color?")).toBe(
      "Asked you a question: Which color?",
    );
    expect(systemNotificationBody("agent.input", "Asks you a question.")).toBe(
      "Asked you a question.",
    );
    expect(systemNotificationBody("agent.input", null)).toBe("Asked you a question.");
    // A secret to paste or help in the browser keep their own words.
    expect(systemNotificationBody("agent.input", "Needs you in the browser: log in")).toBe(
      "Needs you in the browser: log in",
    );
  });

  it("other kinds are unchanged", () => {
    expect(systemNotificationBody("agent.done", "Finished.")).toBe("Finished.");
    expect(systemNotificationBody("app", null)).toBe(null);
  });
});

describe("notification mode", () => {
  it("is on by default, and the old explicit on/off are kept", () => {
    expect(parseNotificationMode(null)).toBe("smart");
    expect(parseNotificationMode("on")).toBe("smart");
    expect(parseNotificationMode("off")).toBe("off");
    expect(parseNotificationMode("needs-you")).toBe("needs-you");
    expect(parseNotificationMode("garbage")).toBe("smart");
  });
});

describe("which inbox items pop up", () => {
  const base = { windowInFront: false, viewingItsChat: false };

  it("an approval, a question (also a call for help in the browser) and an error always do", () => {
    for (const kind of ["agent.approval", "agent.input", "agent.error"]) {
      for (const mode of ["smart", "needs-you"] as const) {
        expect(shouldNotify({ ...base, mode, kind })).toBe(true);
        expect(shouldNotify({ ...base, mode, kind, windowInFront: true })).toBe(true);
      }
    }
  });

  it("not while the person is looking at that very chat", () => {
    expect(
      shouldNotify({
        mode: "smart",
        kind: "agent.approval",
        windowInFront: true,
        viewingItsChat: true,
      }),
    ).toBe(false);
    // Looking at the chat in a window that is in the background — still pop up.
    expect(
      shouldNotify({
        mode: "smart",
        kind: "agent.input",
        windowInFront: false,
        viewingItsChat: true,
      }),
    ).toBe(true);
  });

  it("a finished task (and an app's news) only while the window is in the background", () => {
    for (const kind of ["agent.done", "app"]) {
      expect(shouldNotify({ ...base, mode: "smart", kind })).toBe(true);
      expect(shouldNotify({ ...base, mode: "smart", kind, windowInFront: true })).toBe(false);
      expect(shouldNotify({ ...base, mode: "needs-you", kind })).toBe(false);
    }
  });

  it("off is off", () => {
    for (const kind of ["agent.approval", "agent.input", "agent.error", "agent.done", "app"]) {
      expect(shouldNotify({ ...base, mode: "off", kind })).toBe(false);
    }
  });
});
