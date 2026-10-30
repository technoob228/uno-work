import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { newChatDefaultsFrom } from "./newChatDefaults";

const model = { instanceId: "codex", model: "gpt" } as ServerSettings["defaultModelSelection"];

describe("newChatDefaultsFrom", () => {
  it("uses the computer's values with no project", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultRuntimeMode: "approval-required",
      defaultThreadEnvMode: "worktree",
    };
    expect(newChatDefaultsFrom(settings, null)).toEqual({
      runtimeMode: "approval-required",
      envMode: "worktree",
      projectModel: null,
    });
  });

  it("lets a project's value win over the computer's", () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      defaultRuntimeMode: "approval-required",
      projectSettingsOverrides: {
        p1: { defaultRuntimeMode: "full-access", defaultModelSelection: model as never },
      },
    };
    const defaults = newChatDefaultsFrom(settings, "p1");
    expect(defaults.runtimeMode).toBe("full-access");
    expect(defaults.projectModel).toEqual(model);
    expect(newChatDefaultsFrom(settings, "p2").runtimeMode).toBe("approval-required");
  });

  it("stays on the old full access when nothing was ever set", () => {
    expect(newChatDefaultsFrom(DEFAULT_SERVER_SETTINGS, "p1").runtimeMode).toBe("full-access");
  });
});
