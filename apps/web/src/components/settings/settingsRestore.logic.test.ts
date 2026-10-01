import { DEFAULT_CLIENT_SETTINGS, ServerSettings } from "@t3tools/contracts/settings";
import { Struct } from "effect";
import { describe, expect, it } from "vitest";

import { changedDeviceSettingLabels, deviceRestorePatch } from "./settingsRestore.logic";

describe("Restore defaults", () => {
  it("never touches a computer's settings (Uno key, pins, setup…)", () => {
    const serverKeys = new Set<string>(Struct.keys(ServerSettings.fields));
    const patch = deviceRestorePatch();
    for (const key of Object.keys(patch)) expect(serverKeys.has(key)).toBe(false);
    expect(Object.keys(patch)).not.toContain("uno");
    expect(Object.keys(patch)).not.toContain("pins");
    expect(Object.keys(patch)).not.toContain("onboardingCompleted");
  });

  it("lists only what differs from the defaults", () => {
    expect(changedDeviceSettingLabels({ ...DEFAULT_CLIENT_SETTINGS }, "system")).toEqual([]);
    expect(
      changedDeviceSettingLabels(
        { ...DEFAULT_CLIENT_SETTINGS, diffWordWrap: !DEFAULT_CLIENT_SETTINGS.diffWordWrap },
        "dark",
      ),
    ).toEqual(["Theme", "Diff line wrapping"]);
  });
});
