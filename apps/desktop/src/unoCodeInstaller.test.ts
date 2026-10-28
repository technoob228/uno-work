import { describe, expect, it } from "vitest";

import {
  decideInstall,
  releaseTagToNumericVersion,
  releaseTagToTargetVersion,
  unoBuildNumber,
} from "./unoCodeInstaller.ts";

describe("decideInstall", () => {
  it("installs when the binary is missing", () => {
    const decision = decideInstall({ exists: false, installedVersionRaw: null });
    expect(decision.install).toBe(true);
    expect(decision.reason).toBe("missing");
  });

  it("upgrades when the installed version is older than the target", () => {
    const decision = decideInstall({
      exists: true,
      installedVersionRaw: "1.14.40",
      targetVersion: "1.14.48",
    });
    expect(decision.install).toBe(true);
    expect(decision.reason).toBe("outdated");
    expect(decision.installedVersion).toBe("1.14.40");
    expect(decision.targetVersion).toBe("1.14.48");
  });

  it("does nothing when the installed version meets the target", () => {
    const decision = decideInstall({
      exists: true,
      installedVersionRaw: "1.14.48",
      targetVersion: "1.14.48",
    });
    expect(decision.install).toBe(false);
    expect(decision.reason).toBe("up-to-date");
  });

  it("treats a dev prerelease build as the same numeric version as the release", () => {
    // `1.14.48-uno.dev` shares the numeric core `1.14.48` with the published
    // `1.14.48-uno.1`, so it must NOT be flagged for reinstall.
    const decision = decideInstall({
      exists: true,
      installedVersionRaw: "1.14.48-uno.dev",
      targetVersion: "1.14.48-uno.1",
    });
    expect(decision.install).toBe(false);
    expect(decision.reason).toBe("up-to-date");
  });

  it("upgrades to a newer Uno build of the same upstream version", () => {
    // Release binaries report their tag as the version.
    const decision = decideInstall({
      exists: true,
      installedVersionRaw: "uno-v1.14.48-uno.1",
      targetVersion: "1.14.48-uno.2",
    });
    expect(decision.install).toBe(true);
    expect(decision.reason).toBe("outdated");
  });

  it("does nothing when the installed Uno build is the latest", () => {
    const decision = decideInstall({
      exists: true,
      installedVersionRaw: "uno-v1.14.48-uno.2",
      targetVersion: "1.14.48-uno.2",
    });
    expect(decision.install).toBe(false);
  });

  it("keeps a dev build even when a newer Uno build is released", () => {
    const decision = decideInstall({
      exists: true,
      installedVersionRaw: "1.14.48-uno.dev",
      targetVersion: "1.14.48-uno.2",
    });
    expect(decision.install).toBe(false);
  });

  it("does not downgrade on the offline fallback target", () => {
    const decision = decideInstall({
      exists: true,
      installedVersionRaw: "uno-v1.14.48-uno.1",
      targetVersion: "1.14.48",
    });
    expect(decision.install).toBe(false);
  });

  it("reinstalls when the binary cannot report a parseable version", () => {
    const decision = decideInstall({
      exists: true,
      installedVersionRaw: "garbage output",
      targetVersion: "1.14.48",
    });
    expect(decision.install).toBe(true);
    expect(decision.reason).toBe("outdated");
  });

  it("ignores prerelease suffixes when comparing newer installs", () => {
    const decision = decideInstall({
      exists: true,
      installedVersionRaw: "1.15.0-uno.3",
      targetVersion: "1.14.48",
    });
    expect(decision.install).toBe(false);
    expect(decision.reason).toBe("up-to-date");
  });
});

describe("releaseTagToNumericVersion", () => {
  it("extracts the numeric core from a release tag", () => {
    expect(releaseTagToNumericVersion("uno-v1.14.48-uno.1")).toBe("1.14.48");
  });

  it("returns null for a tag without a numeric version", () => {
    expect(releaseTagToNumericVersion("nightly")).toBeNull();
  });
});

describe("releaseTagToTargetVersion", () => {
  it("keeps the Uno build number", () => {
    expect(releaseTagToTargetVersion("uno-v1.14.48-uno.2")).toBe("1.14.48-uno.2");
  });

  it("falls back to the numeric core", () => {
    expect(releaseTagToTargetVersion("v1.14.48")).toBe("1.14.48");
    expect(releaseTagToTargetVersion("nightly")).toBeNull();
  });
});

describe("unoBuildNumber", () => {
  it("reads the build number and ignores dev builds", () => {
    expect(unoBuildNumber("uno-v1.14.48-uno.12")).toBe(12);
    expect(unoBuildNumber("1.14.48-uno.dev")).toBeNull();
    expect(unoBuildNumber("1.14.48")).toBeNull();
  });
});
