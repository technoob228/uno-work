import { describe, expect, it } from "vitest";

import {
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
