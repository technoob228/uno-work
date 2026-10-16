import { describe, expect, it } from "vitest";

import { resolveDesktopAppBranding, resolveDesktopAppStageLabel } from "./appBranding.ts";

describe("resolveDesktopAppStageLabel", () => {
  it("uses Dev in desktop development", () => {
    expect(
      resolveDesktopAppStageLabel({
        isDevelopment: true,
        appVersion: "0.0.17-nightly.20260414.1",
      }),
    ).toBe("Dev");
  });

  it("uses Nightly for packaged nightly builds", () => {
    expect(
      resolveDesktopAppStageLabel({
        isDevelopment: false,
        appVersion: "0.0.17-nightly.20260414.1",
      }),
    ).toBe("Nightly");
  });

  it("uses Stage for Uno Work Stage, packaged or dev", () => {
    for (const isDevelopment of [false, true]) {
      expect(
        resolveDesktopAppStageLabel({ isDevelopment, appVersion: "0.0.139", flavor: "stage" }),
      ).toBe("Stage");
    }
    expect(
      resolveDesktopAppStageLabel({
        isDevelopment: false,
        appVersion: "0.0.139",
        flavor: "release",
      }),
    ).toBe("Alpha");
  });

  it("uses Alpha for packaged stable builds", () => {
    expect(
      resolveDesktopAppStageLabel({
        isDevelopment: false,
        appVersion: "0.0.17",
      }),
    ).toBe("Alpha");
  });
});

describe("resolveDesktopAppBranding", () => {
  it("returns a complete desktop branding payload", () => {
    expect(
      resolveDesktopAppBranding({
        isDevelopment: false,
        appVersion: "0.0.17-nightly.20260414.1",
      }),
    ).toEqual({
      baseName: "Uno Work",
      stageLabel: "Nightly",
      displayName: "Uno Work (Nightly)",
    });
  });
});
