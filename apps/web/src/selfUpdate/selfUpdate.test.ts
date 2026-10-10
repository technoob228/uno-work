import { describe, expect, it } from "vitest";

import { resolveSelfUpdateView, thisEveningNotBefore, type SelfUpdateStatus } from "./selfUpdate";

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
  supportsLater = false,
) =>
  resolveSelfUpdateView({
    status: status ? { ...base, ...status } : null,
    clientVersion,
    now: NOW,
    pageLoadedAt,
    supportsLater,
  });
/** The same on a computer that lists "update-later". */
const viewLater = (status: Partial<SelfUpdateStatus>) => view(status, "0.0.113", undefined, true);

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
      canLater: false,
      key: "available:0.0.114",
    });
    expect(view({ available: true, latestVersion: "0.0.114", canUpdate: false })).toMatchObject({
      kind: "available",
      canUpdate: false,
    });
  });

  it("offers 'This evening' next to Update only when the computer takes it", () => {
    const out = { available: true, latestVersion: "0.0.114", laterAvailable: true, later: null };
    expect(viewLater(out)).toMatchObject({ kind: "available", canLater: true });
    // An older computer (no "update-later" in httpFeatures): the single Update.
    expect(view(out)).toMatchObject({ kind: "available", canLater: false });
    // Not the owner, or the computer says no (the version was put back there).
    expect(viewLater({ ...out, canUpdate: false })).toMatchObject({ canLater: false });
    expect(viewLater({ ...out, laterAvailable: false })).toMatchObject({ canLater: false });
    expect(viewLater({ available: true, latestVersion: "0.0.114" })).toMatchObject({
      canLater: false,
    });
  });

  it("after 'This evening': a quiet line until the computer updates", () => {
    const evening = "2026-10-08T18:00:00.000Z";
    const out = {
      available: true,
      latestVersion: "0.0.114",
      laterAvailable: true,
      later: { version: "0.0.114", notBefore: evening },
    };
    expect(viewLater(out)).toEqual({
      kind: "later",
      version: "0.0.114",
      due: false,
      canUpdate: true,
      key: `later:${evening}`,
    });
    // The time has come: it now waits only for a quiet moment.
    expect(
      viewLater({ ...out, later: { version: "0.0.114", notBefore: "2026-10-08T11:59:00.000Z" } }),
    ).toMatchObject({ kind: "later", due: true });
    // A client that does not know the feature for this computer ignores it.
    expect(view(out)).toMatchObject({ kind: "available" });
    // While it updates, the usual progress.
    expect(viewLater({ ...out, available: false, state: "updating" })).toMatchObject({
      kind: "updating",
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

describe("thisEveningNotBefore", () => {
  it("is 20:00 today on the person's own clock", () => {
    const now = new Date(2026, 9, 10, 14, 30, 0);
    const at = new Date(thisEveningNotBefore(now));
    expect([at.getFullYear(), at.getMonth(), at.getDate()]).toEqual([2026, 9, 10]);
    expect([at.getHours(), at.getMinutes(), at.getSeconds()]).toEqual([20, 0, 0]);
    // Just after midnight it is still this day's evening.
    expect(new Date(thisEveningNotBefore(new Date(2026, 9, 10, 0, 5, 0))).getHours()).toBe(20);
  });

  it("is now when it is already past 20:00", () => {
    const late = new Date(2026, 9, 10, 21, 15, 0);
    expect(thisEveningNotBefore(late)).toBe(late.toISOString());
    const sharp = new Date(2026, 9, 10, 20, 0, 0);
    expect(thisEveningNotBefore(sharp)).toBe(sharp.toISOString());
  });
});
