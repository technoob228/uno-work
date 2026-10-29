import { describe, expect, it } from "vitest";

import type { AssistantCallsView, CallItem } from "../../lib/assistantCallsApi";
import {
  callTimeLabel,
  joinCallsStage,
  nextCallLine,
  otherAssistantName,
  whyNotLabel,
} from "./joinCalls.logic";

const call = (over: Partial<CallItem> = {}): CallItem => ({
  key: "a1b2c3d4e5f6",
  title: "Pilot sync",
  start: "2026-10-28T14:00:00",
  end: "2026-10-28T14:30:00",
  platform: "meet",
  platformName: "Google Meet",
  join: true,
  why: "auto",
  choice: "",
  session: null,
  ...over,
});

const view = (over: Partial<AssistantCallsView> = {}): AssistantCallsView => ({
  enabled: true,
  projectId: "assistant-ada",
  assistantName: "Ada",
  botName: "Ada (Uno notes)",
  cloud: true,
  google: { connected: true, needsReconnect: false, account: "misha@x.com" },
  notetaker: { state: "running", deploymentId: 1 },
  next: call(),
  upcoming: [call()],
  upcomingAt: 1,
  problem: null,
  recent: [],
  notes: [],
  ...over,
});

const NOW = Date.parse("2026-10-28T09:00:00");

describe("join calls words", () => {
  it("says when the bot goes next", () => {
    expect(nextCallLine(view(), NOW, "en-GB")).toBe("Joining Pilot sync at 14:00");
    expect(
      nextCallLine(view({ next: call({ session: { status: "lobby", detail: "" } }) }), NOW),
    ).toBe("Waiting to be let into Pilot sync");
    expect(
      nextCallLine(view({ next: call({ session: { status: "recording", detail: "" } }) }), NOW),
    ).toBe("In Pilot sync now, taking notes");
    expect(nextCallLine(view({ next: null }), NOW)).toBe("No calls with a link coming up.");
  });

  it("names the day", () => {
    expect(callTimeLabel("2026-10-29T09:30:00", NOW, "en-GB")).toBe("tomorrow 09:30");
    expect(callTimeLabel("2026-10-30T09:30:00", NOW, "en-GB")).toBe("Fri 09:30");
    expect(callTimeLabel("2026-11-20T09:30:00", NOW, "en-GB")).toBe("20 Nov, 09:30");
  });

  it("explains a skipped meeting", () => {
    expect(whyNotLabel(call({ join: false, why: "nobody else is invited" }))).toBe(
      "only you are invited",
    );
    expect(whyNotLabel(call())).toBe("");
  });

  it("knows the stage and who else has it", () => {
    expect(joinCallsStage(view(), "assistant-ada")).toBe("on");
    expect(joinCallsStage(view(), "assistant-bob")).toBe("off");
    expect(otherAssistantName(view(), "assistant-bob")).toBe("Ada");
    expect(
      joinCallsStage(
        view({ google: { connected: true, needsReconnect: true, account: null } }),
        "assistant-ada",
      ),
    ).toBe("reconnect");
    expect(
      joinCallsStage(
        view({ notetaker: { state: "installing", deploymentId: 2 }, upcomingAt: null, recent: [] }),
        "assistant-ada",
      ),
    ).toBe("setting-up");
    // a store reinstall still "installing", but the notetaker already reported: it runs
    expect(
      joinCallsStage(
        view({ notetaker: { state: "installing", deploymentId: 2 }, upcomingAt: 1793204506 }),
        "assistant-ada",
      ),
    ).toBe("on");
    expect(joinCallsStage(view({ enabled: false }), "assistant-ada")).toBe("off");
  });
});
