import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  clearProjectSettingsOverrides,
  hasProjectSettingsOverrides,
  resolveProjectSettings,
} from "./projectSettings.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const withOverrides = (
  projectSettingsOverrides: ServerSettings["projectSettingsOverrides"],
): ServerSettings => ({ ...DEFAULT_SERVER_SETTINGS, projectSettingsOverrides });

describe("resolveProjectSettings", () => {
  it("returns the computer's settings when the project overrides nothing", () => {
    const resolved = resolveProjectSettings(DEFAULT_SERVER_SETTINGS, "p1");
    expect(resolved.settings).toBe(DEFAULT_SERVER_SETTINGS);
    expect(resolved.sources.defaultRuntimeMode).toBe("environment");
  });

  it("takes the project's value and says where it came from", () => {
    const settings = withOverrides({ p1: { defaultRuntimeMode: "approval-required" } });
    const resolved = resolveProjectSettings(settings, "p1");
    expect(resolved.settings.defaultRuntimeMode).toBe("approval-required");
    expect(resolved.sources.defaultRuntimeMode).toBe("project");
    expect(resolved.sources.defaultThreadEnvMode).toBe("environment");
  });

  it("does not leak one project's value into another or into no project", () => {
    const settings = withOverrides({ p1: { defaultThreadEnvMode: "worktree" } });
    expect(resolveProjectSettings(settings, "p2").settings.defaultThreadEnvMode).toBe("local");
    expect(resolveProjectSettings(settings, null).settings.defaultThreadEnvMode).toBe("local");
  });
});

describe("clearProjectSettingsOverrides", () => {
  it("drops one key and keeps the rest", () => {
    const settings = withOverrides({
      p1: { defaultRuntimeMode: "approval-required", defaultThreadEnvMode: "worktree" },
    });
    expect(clearProjectSettingsOverrides(settings, "p1", ["defaultRuntimeMode"])).toEqual({
      defaultThreadEnvMode: "worktree",
    });
  });

  it("returns null when nothing is left, so the entry goes away", () => {
    const settings = withOverrides({ p1: { defaultRuntimeMode: "approval-required" } });
    expect(clearProjectSettingsOverrides(settings, "p1", ["defaultRuntimeMode"])).toBeNull();
  });
});

describe("applyServerSettingsPatch with project overrides", () => {
  it("replaces one project's entry and leaves the others", () => {
    const settings = withOverrides({
      p1: { defaultRuntimeMode: "approval-required", defaultThreadEnvMode: "worktree" },
      p2: { defaultThreadEnvMode: "worktree" },
    });
    const next = applyServerSettingsPatch(settings, {
      projectSettingsOverrides: { p1: { defaultRuntimeMode: "full-access" } },
    });
    expect(next.projectSettingsOverrides).toEqual({
      p1: { defaultRuntimeMode: "full-access" },
      p2: { defaultThreadEnvMode: "worktree" },
    });
  });

  it("removes an entry on null", () => {
    const settings = withOverrides({ p1: { defaultRuntimeMode: "approval-required" } });
    const next = applyServerSettingsPatch(settings, { projectSettingsOverrides: { p1: null } });
    expect(next.projectSettingsOverrides).toEqual({});
    expect(hasProjectSettingsOverrides(next)).toBe(false);
  });

  it("replaces the computer's model whole, so old options don't survive", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultModelSelection: {
        instanceId: "codex",
        model: "a",
        options: [{ id: "effort", value: "high" }],
      } as unknown as ServerSettings["defaultModelSelection"],
    };
    const next = applyServerSettingsPatch(settings, {
      defaultModelSelection: { instanceId: "claudeAgent", model: "b" },
    } as Parameters<typeof applyServerSettingsPatch>[1]);
    expect(next.defaultModelSelection).toEqual({ instanceId: "claudeAgent", model: "b" });
    expect(
      applyServerSettingsPatch(next, { defaultModelSelection: null }).defaultModelSelection,
    ).toBeNull();
  });
});
