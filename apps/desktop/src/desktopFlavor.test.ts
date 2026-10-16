import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isAutoUpdateAllowedForFlavor,
  parseDesktopFlavor,
  readDesktopFlavorFromPackageJson,
  resolveDesktopFlavor,
  resolveDesktopIdentity,
  resolveFlavorBackendEnv,
  resolveUserDataPath,
} from "./desktopFlavor.ts";

const HOME = "/Users/misha";

describe("resolveDesktopFlavor", () => {
  it("is the release without any sign", () => {
    expect(resolveDesktopFlavor({ envValue: undefined, packageJsonRaw: null })).toBe("release");
    expect(
      resolveDesktopFlavor({
        envValue: undefined,
        packageJsonRaw: JSON.stringify({ name: "t3code", version: "0.0.139" }),
      }),
    ).toBe("release");
  });

  it("reads the packaged app's package.json", () => {
    expect(
      resolveDesktopFlavor({
        envValue: undefined,
        packageJsonRaw: JSON.stringify({ version: "0.0.139", unoWorkFlavor: "stage" }),
      }),
    ).toBe("stage");
  });

  it("does not take a nightly version for the stage", () => {
    expect(
      resolveDesktopFlavor({
        envValue: undefined,
        packageJsonRaw: JSON.stringify({ version: "0.0.139-nightly.20261016.1" }),
      }),
    ).toBe("release");
  });

  it("lets the env make a run the stage, never the other way round", () => {
    const stagePackage = JSON.stringify({ unoWorkFlavor: "stage" });
    expect(resolveDesktopFlavor({ envValue: "stage", packageJsonRaw: null })).toBe("stage");
    // A stage build never opens the release app's data.
    expect(resolveDesktopFlavor({ envValue: "release", packageJsonRaw: stagePackage })).toBe(
      "stage",
    );
    expect(resolveDesktopFlavor({ envValue: "prod!", packageJsonRaw: stagePackage })).toBe("stage");
  });

  it("survives a broken package.json", () => {
    expect(readDesktopFlavorFromPackageJson("{not json")).toBeNull();
    expect(readDesktopFlavorFromPackageJson("null")).toBeNull();
    expect(parseDesktopFlavor(" Stage ")).toBe("stage");
    expect(parseDesktopFlavor(42)).toBeNull();
  });
});

describe("resolveDesktopIdentity", () => {
  it("keeps the release app exactly as before", () => {
    expect(
      resolveDesktopIdentity({
        flavor: "release",
        isDevelopment: false,
        homeDir: HOME,
        t3codeHome: undefined,
      }),
    ).toEqual({
      baseDir: Path.join(HOME, ".unowork"),
      userDataDirName: "unowork",
      legacyUserDataDirName: "T3 Code (Alpha)",
      appUserModelId: "xyz.getuno.work",
      linuxDesktopEntryName: "unowork.desktop",
      linuxWmClass: "unowork",
    });
    expect(
      resolveDesktopIdentity({
        flavor: "release",
        isDevelopment: true,
        homeDir: HOME,
        t3codeHome: "/tmp/dev-home",
      }),
    ).toEqual({
      baseDir: "/tmp/dev-home",
      userDataDirName: "unowork-dev",
      legacyUserDataDirName: "T3 Code (Dev)",
      appUserModelId: "xyz.getuno.work.dev",
      linuxDesktopEntryName: "unowork-dev.desktop",
      linuxWmClass: "unowork-dev",
    });
  });

  it("gives the stage its own home, profile and ids, without the legacy profile", () => {
    expect(
      resolveDesktopIdentity({
        flavor: "stage",
        isDevelopment: false,
        homeDir: HOME,
        t3codeHome: "  ",
      }),
    ).toEqual({
      baseDir: Path.join(HOME, ".unowork-stage"),
      userDataDirName: "unowork-stage",
      legacyUserDataDirName: null,
      appUserModelId: "xyz.getuno.work.stage",
      linuxDesktopEntryName: "unowork-stage.desktop",
      linuxWmClass: "unowork-stage",
    });
  });

  it("never shares a name with the release app in any mode", () => {
    for (const isDevelopment of [false, true]) {
      const release = resolveDesktopIdentity({
        flavor: "release",
        isDevelopment,
        homeDir: HOME,
        t3codeHome: undefined,
      });
      const stage = resolveDesktopIdentity({
        flavor: "stage",
        isDevelopment,
        homeDir: HOME,
        t3codeHome: undefined,
      });
      expect(stage.baseDir).not.toBe(release.baseDir);
      expect(stage.userDataDirName).not.toBe(release.userDataDirName);
      expect(stage.appUserModelId).not.toBe(release.appUserModelId);
    }
  });
});

const legacyExists = (path: string) => path.endsWith("T3 Code (Alpha)");

describe("resolveUserDataPath", () => {
  const appDataBase = Path.join(HOME, "Library", "Application Support");

  it("adopts the legacy profile only for the release app", () => {
    const exists = legacyExists;
    const release = resolveDesktopIdentity({
      flavor: "release",
      isDevelopment: false,
      homeDir: HOME,
      t3codeHome: undefined,
    });
    const stage = resolveDesktopIdentity({
      flavor: "stage",
      isDevelopment: false,
      homeDir: HOME,
      t3codeHome: undefined,
    });
    expect(resolveUserDataPath({ appDataBase, identity: release, exists })).toBe(
      Path.join(appDataBase, "T3 Code (Alpha)"),
    );
    expect(resolveUserDataPath({ appDataBase, identity: stage, exists })).toBe(
      Path.join(appDataBase, "unowork-stage"),
    );
    expect(resolveUserDataPath({ appDataBase, identity: release, exists: () => false })).toBe(
      Path.join(appDataBase, "unowork"),
    );
  });
});

describe("resolveFlavorBackendEnv", () => {
  const baseDir = Path.join(HOME, ".unowork-stage");

  it("adds nothing for the release app", () => {
    expect(resolveFlavorBackendEnv({ flavor: "release", baseDir, env: {} })).toEqual({});
  });

  it("points the stage daemon at its own folders and channel", () => {
    expect(resolveFlavorBackendEnv({ flavor: "stage", baseDir, env: {} })).toEqual({
      UNO_WORK_APPS_DIR: Path.join(baseDir, "uno-apps"),
      UNO_WORK_ASSISTANTS_DIR: Path.join(baseDir, "Assistants"),
      UNO_WORK_HARNESS_DIR: baseDir,
      UNO_WORK_CHANNEL: "stage",
    });
  });

  it("keeps what is set on purpose", () => {
    expect(
      resolveFlavorBackendEnv({
        flavor: "stage",
        baseDir,
        env: { UNO_WORK_APPS_DIR: "/tmp/apps", UNO_WORK_CHANNEL: "" },
      }),
    ).toEqual({
      UNO_WORK_ASSISTANTS_DIR: Path.join(baseDir, "Assistants"),
      UNO_WORK_HARNESS_DIR: baseDir,
      UNO_WORK_CHANNEL: "stage",
    });
  });
});

describe("isAutoUpdateAllowedForFlavor", () => {
  it("never updates the stage", () => {
    expect(isAutoUpdateAllowedForFlavor("release")).toBe(true);
    expect(isAutoUpdateAllowedForFlavor("stage")).toBe(false);
  });
});
