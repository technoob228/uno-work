import { describe, expect, it } from "vitest";

import {
  resolveSelfUpdateView,
  SELF_UPDATE_COPY,
  workingAgentsOf,
  type SelfUpdateStatus,
} from "./selfUpdate";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const base: SelfUpdateStatus = {
  supported: true,
  canUpdate: true,
  currentVersion: "0.0.113",
  latestVersion: "0.0.113",
  available: false,
  state: "idle",
  step: null,
  error: null,
  fromVersion: null,
  toVersion: null,
  rolledBack: false,
  startedAt: null,
  finishedAt: null,
};
const view = (
  status: Partial<SelfUpdateStatus> | null,
  clientVersion = "0.0.113",
  pageLoadedAt = Date.parse("2026-10-08T11:00:00Z"),
) =>
  resolveSelfUpdateView({
    status: status ? { ...base, ...status } : null,
    clientVersion,
    now: NOW,
    pageLoadedAt,
  });

describe("resolveSelfUpdateView", () => {
  it("shows nothing on a computer that can't update itself or is up to date", () => {
    expect(view(null)).toBeNull();
    expect(view({ supported: false, available: true, latestVersion: "0.0.114" })).toBeNull();
    expect(view({})).toBeNull();
  });

  it("offers the new version; only the owner gets the button", () => {
    expect(view({ available: true, latestVersion: "0.0.114" })).toEqual({
      kind: "available",
      version: "0.0.114",
      canUpdate: true,
      key: "available:0.0.114",
    });
    expect(view({ available: true, latestVersion: "0.0.114", canUpdate: false })).toMatchObject({
      kind: "available",
      canUpdate: false,
    });
  });

  it("follows a running update", () => {
    expect(
      view({ state: "updating", step: "Downloading Uno Work 0.0.114", toVersion: "0.0.114" }),
    ).toEqual({ kind: "updating", version: "0.0.114", step: "Downloading Uno Work 0.0.114" });
  });

  it("a fresh success asks an old page to reload; a day later it is not news", () => {
    const done = {
      state: "done" as const,
      currentVersion: "0.0.114",
      latestVersion: "0.0.114",
      toVersion: "0.0.114",
      finishedAt: "2026-10-08T11:58:00Z",
    };
    expect(view(done, "0.0.113")).toMatchObject({
      kind: "done",
      version: "0.0.114",
      needsReload: true,
    });
    expect(view(done, "0.0.114")).toMatchObject({ kind: "done", needsReload: false });
    // Loaded after the update: whatever version this interface serves, no reload loop.
    expect(view(done, "0.0.113", Date.parse("2026-10-08T11:59:00Z"))).toMatchObject({
      kind: "done",
      needsReload: false,
    });
    expect(view({ ...done, finishedAt: "2026-10-06T11:58:00Z" }, "0.0.114")).toBeNull();
  });

  it("a failed update says why and can be tried again while the release is still newer", () => {
    expect(
      view({
        state: "failed",
        error:
          "Uno Work 0.0.114 didn't start within 120 seconds. This computer is back on Uno Work 0.0.113.",
        rolledBack: true,
        available: true,
        latestVersion: "0.0.114",
        finishedAt: "2026-10-08T11:59:00Z",
      }),
    ).toMatchObject({ kind: "failed", canRetry: true, version: "0.0.114" });
    // An old failure gives way to the plain offer.
    expect(
      view({
        state: "failed",
        error: "x",
        available: true,
        latestVersion: "0.0.114",
        finishedAt: "2026-10-01T11:59:00Z",
      }),
    ).toMatchObject({ kind: "available" });
  });
});

describe("agents working during an update", () => {
  it("counts them, and a computer that can't tell counts as none", () => {
    expect(workingAgentsOf({ ...base, workingAgents: 2 })).toBe(2);
    expect(workingAgentsOf({ ...base, workingAgents: 0 })).toBe(0);
    // An older Uno Work on the computer: the old "Update now" question.
    expect(workingAgentsOf(base)).toBe(0);
    expect(workingAgentsOf(null)).toBe(0);
  });

  it("asks concretely, in one plain sentence each", () => {
    expect(SELF_UPDATE_COPY.agentsWorking(2)).toBe("2 agents are working right now.");
    expect(SELF_UPDATE_COPY.agentsWorking(1)).toBe("1 agent is working right now.");
    expect(SELF_UPDATE_COPY.confirmBodyAgents).toBe(
      "Update after they finish, or update now and they'll continue on their own after the restart.",
    );
    expect(SELF_UPDATE_COPY.updateWhenDone(2)).toBe("Update when they finish");
    expect(SELF_UPDATE_COPY.updateWhenDone(1)).toBe("Update when it finishes");
  });

  it("shows the update waiting for them, until when", () => {
    const waiting = {
      requestedAt: "2026-10-08T11:55:00Z",
      deadlineAt: "2026-10-08T12:25:00Z",
    };
    expect(view({ available: true, latestVersion: "0.0.114", workingAgents: 2, waiting })).toEqual({
      kind: "waiting",
      version: "0.0.114",
      agents: 2,
      deadlineAt: waiting.deadlineAt,
      canUpdate: true,
      key: "waiting:2026-10-08T11:55:00Z",
    });
    expect(SELF_UPDATE_COPY.waitingBody(2, "12:25")).toBe(
      "2 agents are still working. The update starts when they're done, by 12:25 at the latest.",
    );
    expect(SELF_UPDATE_COPY.waitingBody(0, "12:25")).toBe(
      "The agents are done. The update starts in a moment.",
    );
    // Once it runs, it is the running update.
    expect(
      view({ state: "updating", step: "Starting", toVersion: "0.0.114", waiting }),
    ).toMatchObject({ kind: "updating" });
  });
});
