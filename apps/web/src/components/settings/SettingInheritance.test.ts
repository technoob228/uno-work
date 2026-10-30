import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { describe, expect, it } from "vitest";

import { formatSettingValue, settingInheritanceLayers } from "./SettingInheritance";
import type { ScopedSettingsTarget } from "./scopedSettings";

const model = { instanceId: "codex", model: "gpt-5" } as unknown as ModelSelection;

const targetFor = (settings: ServerSettings, projectId: string | null): ScopedSettingsTarget => {
  const resolved = resolveProjectSettings(settings, projectId);
  return {
    environmentId: "env-mac" as EnvironmentId,
    label: "Mainbook",
    projectId,
    settings: resolved.settings,
    sources: resolved.sources,
  };
};

const winner = (layers: ReturnType<typeof settingInheritanceLayers>) =>
  layers.filter((layer) => layer.effective).map((layer) => layer.key);

describe("settingInheritanceLayers", () => {
  it("shows the built-in default when nothing is set", () => {
    const layers = settingInheritanceLayers(
      targetFor(DEFAULT_SERVER_SETTINGS, null),
      DEFAULT_SERVER_SETTINGS,
      "defaultRuntimeMode",
    );
    expect(layers.map((layer) => layer.key)).toEqual(["environment", "built-in"]);
    expect(winner(layers)).toEqual(["built-in"]);
    expect(layers[1]?.value).toBe("Full access");
  });

  it("lets the project win and keeps the computer's value visible", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultRuntimeMode: "auto-accept-edits",
      projectSettingsOverrides: { p1: { defaultRuntimeMode: "approval-required" } },
    };
    const layers = settingInheritanceLayers(
      targetFor(settings, "p1"),
      settings,
      "defaultRuntimeMode",
    );
    expect(winner(layers)).toEqual(["project"]);
    expect(layers.map((layer) => layer.value)).toEqual([
      "Ask before changes",
      "Edit files freely",
      "Full access",
    ]);
  });

  it("adds the all-computers layer for the model only", () => {
    const layers = settingInheritanceLayers(
      targetFor(DEFAULT_SERVER_SETTINGS, null),
      DEFAULT_SERVER_SETTINGS,
      "defaultModelSelection",
      model,
    );
    expect(layers.map((layer) => layer.key)).toEqual(["environment", "app", "built-in"]);
    expect(winner(layers)).toEqual(["app"]);
    expect(layers[1]?.value).toBe("gpt-5");
    expect(layers[2]?.value).toBe("Last picked");
  });

  it("lets a computer's model win over all computers", () => {
    const settings: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: model };
    const layers = settingInheritanceLayers(
      targetFor(settings, null),
      settings,
      "defaultModelSelection",
      { ...model, model: "other" } as ModelSelection,
    );
    expect(winner(layers)).toEqual(["environment"]);
  });

  it("has exactly one winner in every case", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultThreadEnvMode: "worktree",
      projectSettingsOverrides: { p1: { defaultThreadEnvMode: "local" } },
    };
    for (const projectId of [null, "p1", "p2"]) {
      const layers = settingInheritanceLayers(
        targetFor(settings, projectId),
        settings,
        "defaultThreadEnvMode",
      );
      expect(winner(layers)).toHaveLength(1);
    }
  });
});

describe("formatSettingValue", () => {
  it("speaks the app's words", () => {
    expect(formatSettingValue("defaultThreadEnvMode", "worktree")).toBe("In a separate copy");
    expect(formatSettingValue("branchNamingMode", "semantic")).toBe("Semantic prefix");
    expect(formatSettingValue("sidebarAutoSettleOnMerge", false)).toBe("Off");
    expect(formatSettingValue("branchNamePrefix", "")).toBe("Empty");
  });
});
