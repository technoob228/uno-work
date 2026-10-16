import { describe, expect, it } from "vitest";

import {
  FEATURE_FLAGS,
  SIDEBAR_RESET_MARKER,
  featureFlagDefault,
  resetOldSidebarsOnce,
  migrateFeatureFlagOverrides,
  readStoredFeatureFlag,
  resolveFeatureFlag,
} from "./featureFlags";

describe("feature flags", () => {
  it("turns inbox sections on by default and the all-machines sidebar off", () => {
    expect(resolveFeatureFlag({}, "inboxSections")).toBe(true);
    expect(resolveFeatureFlag(undefined, "allMachinesSidebar")).toBe(false);
  });

  it("reads the all-machines sidebar choice stored under the old sidebarInbox key", () => {
    expect(resolveFeatureFlag({ sidebarInbox: true }, "allMachinesSidebar")).toBe(true);
    expect(readStoredFeatureFlag({ sidebarInbox: true }, "allMachinesSidebar")).toBe(true);
  });

  it("prefers the new key over the legacy one", () => {
    expect(
      resolveFeatureFlag({ sidebarInbox: true, allMachinesSidebar: false }, "allMachinesSidebar"),
    ).toBe(false);
  });

  it("moves legacy keys to their new names on write", () => {
    expect(migrateFeatureFlagOverrides({ sidebarInbox: true, vault: false })).toEqual({
      allMachinesSidebar: true,
      vault: false,
    });
    expect(migrateFeatureFlagOverrides({ sidebarInbox: true, allMachinesSidebar: false })).toEqual({
      allMachinesSidebar: false,
    });
  });
});

describe("resetOldSidebarsOnce", () => {
  const base = { featureFlags: {} as Record<string, boolean>, sidebarEnvironmentScope: "active" };

  it("turns the old sidebars off once and leaves a marker", () => {
    const { settings, changed } = resetOldSidebarsOnce(
      {
        ...base,
        featureFlags: { legacySidebar: true, allMachinesSidebar: true, vault: false },
        sidebarEnvironmentScope: "all",
      },
      "active",
    );
    expect(changed).toBe(true);
    expect(settings.featureFlags).toEqual({ vault: false, [SIDEBAR_RESET_MARKER]: true });
    expect(settings.sidebarEnvironmentScope).toBe("active");
    expect(resolveFeatureFlag(settings.featureFlags, "legacySidebar")).toBe(false);
    expect(resolveFeatureFlag(settings.featureFlags, "allMachinesSidebar")).toBe(false);
  });

  it("drops the pre-rename sidebarInbox key too", () => {
    const { settings } = resetOldSidebarsOnce(
      { ...base, featureFlags: { sidebarInbox: true }, sidebarEnvironmentScope: "all" },
      "active",
    );
    expect(resolveFeatureFlag(settings.featureFlags, "allMachinesSidebar")).toBe(false);
    expect(settings.sidebarEnvironmentScope).toBe("active");
  });

  it("keeps the person's later choice once the marker is there", () => {
    const after = {
      ...base,
      featureFlags: { legacySidebar: true, [SIDEBAR_RESET_MARKER]: true },
    };
    const { settings, changed } = resetOldSidebarsOnce(after, "active");
    expect(changed).toBe(false);
    expect(settings).toBe(after);
  });

  it("does not touch the scope when the all-machines sidebar was off", () => {
    const { settings } = resetOldSidebarsOnce(
      { ...base, featureFlags: { legacySidebar: true }, sidebarEnvironmentScope: "all" },
      "active",
    );
    expect(settings.sidebarEnvironmentScope).toBe("all");
  });
});

describe("stage defaults (w0139)", () => {
  const stageKeys = FEATURE_FLAGS.filter(
    (flag) => "stageDefault" in flag && flag.stageDefault === true,
  ).map((flag) => flag.key);

  it("keeps only the assistants (Uno's chats) to the stage channel", () => {
    expect(stageKeys).toEqual(["assistantChatsInSidebar"]);
    for (const key of stageKeys) {
      expect(resolveFeatureFlag({}, key, false)).toBe(false);
      expect(featureFlagDefault(key, false)).toBe(false);
    }
  });

  it("turns the new work on on the stage channel until the person chooses", () => {
    for (const key of stageKeys) {
      expect(resolveFeatureFlag({}, key, true)).toBe(true);
      expect(resolveFeatureFlag({ [key]: false }, key, true)).toBe(false);
      expect(resolveFeatureFlag({ [key]: true }, key, false)).toBe(true);
    }
  });

  it("has the rest of w0139 on for everyone since 0.0.141 (each can be turned off)", () => {
    for (const key of [
      "panelLauncherV2",
      "browserPageTools",
      "fullscreenChatDock",
      "panelTabGroups",
      "sidebarViewMenu",
      "fileShareButton",
    ] as const) {
      expect(featureFlagDefault(key, false)).toBe(true);
      expect(resolveFeatureFlag({ [key]: false }, key, false)).toBe(false);
    }
  });

  it("leaves the other flags as they were on the stage", () => {
    expect(resolveFeatureFlag({}, "navLayouts", true)).toBe(false);
    expect(resolveFeatureFlag({}, "vault", true)).toBe(true);
  });
});
