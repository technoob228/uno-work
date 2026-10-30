import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  listProjectOverrides,
  persistScopedSettingsPatch,
  planProjectOverridesClear,
  planScopedSettingsClear,
  planScopedSettingsPatch,
  resolveScopedSettingsTargets,
  scopedSettingsAreMixed,
  scopedSettingsSource,
  type ScopedSettingsEnvironment,
} from "./scopedSettings";
import { resolveSettingsScope } from "./settingsScope";

const mac = "env-mac" as EnvironmentId;
const box = "env-box" as EnvironmentId;
const asleep = "env-asleep" as EnvironmentId;
const model = { instanceId: "codex", model: "gpt" } as unknown as ModelSelection;

const computer = (
  environmentId: EnvironmentId,
  label: string,
  settings: Partial<ServerSettings> = {},
  connected = true,
): ScopedSettingsEnvironment => ({
  environmentId,
  label,
  connected,
  serverConfig: { settings: { ...DEFAULT_SERVER_SETTINGS, ...settings } },
});

const shop = {
  projectKey: "shop",
  displayName: "shop",
  memberProjects: [
    { id: "p-mac", environmentId: mac, physicalProjectKey: "mac:p" },
    { id: "p-box", environmentId: box, physicalProjectKey: "box:p" },
    { id: "p-asleep", environmentId: asleep, physicalProjectKey: "asleep:p" },
  ],
} as unknown as SidebarProjectSnapshot;

const scopeOf = (
  search: { project?: string; machine?: string },
  environments: readonly ScopedSettingsEnvironment[],
) => resolveSettingsScope(search, [shop], environments);

describe("planScopedSettingsPatch", () => {
  it("writes to every computer that is on and names the one that isn't", () => {
    const environments = [
      computer(mac, "Mainbook"),
      computer(box, "uno-work"),
      computer(asleep, "uno-product", {}, false),
    ];
    const plan = planScopedSettingsPatch(scopeOf({}, environments), environments, {
      defaultRuntimeMode: "approval-required",
    });
    expect(plan.serverWrites.map((write) => write.environmentId)).toEqual([mac, box]);
    expect(plan.skipped).toEqual(["uno-product"]);
  });

  it("writes only to the chosen computer", () => {
    const environments = [computer(mac, "Mainbook"), computer(box, "uno-work")];
    const plan = planScopedSettingsPatch(scopeOf({ machine: box }, environments), environments, {
      defaultThreadEnvMode: "worktree",
    });
    expect(plan.serverWrites.map((write) => write.environmentId)).toEqual([box]);
  });

  it("keeps a project's write on that project and leaves its other values", () => {
    const environments = [
      computer(mac, "Mainbook", {
        projectSettingsOverrides: { "p-mac": { defaultThreadEnvMode: "worktree" } },
      }),
    ];
    const plan = planScopedSettingsPatch(scopeOf({ project: "shop" }, environments), environments, {
      defaultRuntimeMode: "approval-required",
    });
    expect(plan.serverWrites[0]?.patch).toEqual({
      projectSettingsOverrides: {
        "p-mac": { defaultThreadEnvMode: "worktree", defaultRuntimeMode: "approval-required" },
      },
    });
  });

  it("refuses a computer-wide setting on a project", () => {
    const environments = [computer(mac, "Mainbook")];
    const plan = planScopedSettingsPatch(scopeOf({ project: "shop" }, environments), environments, {
      enableAssistantStreaming: true,
    });
    expect(plan.serverWrites).toEqual([]);
    expect(plan.unavailableReason).toContain("whole computer");
  });

  it("never turns a stale selection into a write", () => {
    const environments = [computer(mac, "Mainbook")];
    const plan = planScopedSettingsPatch(scopeOf({ machine: "gone" }, environments), environments, {
      defaultRuntimeMode: "full-access",
    });
    expect(plan.serverWrites).toEqual([]);
    expect(plan.unavailableReason).toBe("This computer is no longer available.");
  });

  it("says so when the only computer is off", () => {
    const environments = [computer(box, "uno-work", {}, false)];
    const plan = planScopedSettingsPatch(scopeOf({ machine: box }, environments), environments, {
      defaultRuntimeMode: "full-access",
    });
    expect(plan.unavailableReason).toBe("Turn on uno-work to save this.");
  });
});

describe("the model for new chats", () => {
  it("goes to the app for all computers, so sleeping ones get it too", () => {
    const environments = [computer(mac, "Mainbook"), computer(asleep, "uno-product", {}, false)];
    const plan = planScopedSettingsPatch(scopeOf({}, environments), environments, {
      defaultModelSelection: model,
    });
    expect(plan.clientPatch).toEqual({ newChatModelSelection: model });
    expect(plan.serverWrites).toEqual([]);
  });

  it("clears a computer's own model when set for all computers", () => {
    const environments = [
      computer(mac, "Mainbook", { defaultModelSelection: model }),
      computer(box, "uno-work"),
    ];
    const plan = planScopedSettingsPatch(scopeOf({}, environments), environments, {
      defaultModelSelection: null,
    });
    expect(plan.clientPatch).toEqual({ newChatModelSelection: null });
    expect(plan.serverWrites.map((write) => write.environmentId)).toEqual([mac]);
    expect(plan.serverWrites[0]?.patch).toEqual({ defaultModelSelection: null });
  });

  it("stays on the computer when one is chosen", () => {
    const environments = [computer(mac, "Mainbook"), computer(box, "uno-work")];
    const plan = planScopedSettingsPatch(scopeOf({ machine: mac }, environments), environments, {
      defaultModelSelection: model,
    });
    expect(plan.hasClientWrite).toBe(false);
    expect(plan.serverWrites[0]?.patch).toEqual({ defaultModelSelection: model });
  });

  it("drops a project's model on null, since null can't be stored there", () => {
    const environments = [
      computer(mac, "Mainbook", {
        projectSettingsOverrides: { "p-mac": { defaultModelSelection: model } },
      }),
    ];
    const plan = planScopedSettingsPatch(scopeOf({ project: "shop" }, environments), environments, {
      defaultModelSelection: null,
    });
    expect(plan.serverWrites[0]?.patch).toEqual({ projectSettingsOverrides: { "p-mac": null } });
  });
});

describe("reading a scope", () => {
  const environments = [
    computer(mac, "Mainbook", { defaultRuntimeMode: "approval-required" }),
    computer(box, "uno-work", {
      projectSettingsOverrides: { "p-box": { defaultRuntimeMode: "auto-accept-edits" } },
    }),
  ];

  it("sees that computers differ", () => {
    const targets = resolveScopedSettingsTargets(scopeOf({}, environments), environments);
    expect(scopedSettingsAreMixed(targets, ["defaultRuntimeMode"])).toBe(true);
    expect(scopedSettingsAreMixed(targets, ["defaultThreadEnvMode"])).toBe(false);
  });

  it("says where a project's value comes from on each computer", () => {
    const targets = resolveScopedSettingsTargets(
      scopeOf({ project: "shop" }, environments),
      environments,
    );
    expect(targets.map((target) => target.settings.defaultRuntimeMode)).toEqual([
      "approval-required",
      "auto-accept-edits",
    ]);
    expect(scopedSettingsSource(targets, ["defaultRuntimeMode"])).toBe("mixed");
    expect(scopedSettingsSource([targets[1]!], ["defaultRuntimeMode"])).toBe("project");
    expect(scopedSettingsSource([targets[0]!], ["defaultRuntimeMode"])).toBe("environment");
  });

  it("lists the projects with their own value", () => {
    expect(listProjectOverrides(environments, ["defaultRuntimeMode"])).toEqual([
      { environmentId: box, projectId: "p-box" },
    ]);
    expect(listProjectOverrides(environments, ["defaultThreadEnvMode"])).toEqual([]);
  });
});

describe("resetting", () => {
  const environments = [
    computer(mac, "Mainbook", {
      projectSettingsOverrides: {
        "p-mac": { defaultRuntimeMode: "approval-required", defaultThreadEnvMode: "worktree" },
      },
    }),
  ];

  it("drops only the row's key", () => {
    const plan = planScopedSettingsClear(scopeOf({ project: "shop" }, environments), environments, [
      "defaultRuntimeMode",
    ]);
    expect(plan.serverWrites[0]?.patch).toEqual({
      projectSettingsOverrides: { "p-mac": { defaultThreadEnvMode: "worktree" } },
    });
  });

  it("resets a project from the computer's row", () => {
    const plan = planProjectOverridesClear(
      environments,
      [{ environmentId: mac, projectId: "p-mac" }],
      ["defaultRuntimeMode", "defaultThreadEnvMode"],
    );
    expect(plan.serverWrites[0]?.patch).toEqual({ projectSettingsOverrides: { "p-mac": null } });
  });
});

describe("persistScopedSettingsPatch", () => {
  const environments = [computer(mac, "Mainbook"), computer(box, "uno-work")];
  const plan = planScopedSettingsPatch(scopeOf({}, environments), environments, {
    defaultRuntimeMode: "approval-required",
  });

  it("reports what saved and what failed", async () => {
    const outcome = await persistScopedSettingsPatch(
      plan,
      async (environmentId) => {
        if (environmentId === box) throw new Error("Disconnected");
        return { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "approval-required" };
      },
      () => {},
    );
    expect(outcome.saved).toEqual(["Mainbook"]);
    expect(outcome.failed).toEqual([{ label: "uno-work", message: "Disconnected" }]);
  });

  it("catches an older computer that ignored the setting", async () => {
    const outcome = await persistScopedSettingsPatch(
      plan,
      async () => DEFAULT_SERVER_SETTINGS,
      () => {},
    );
    expect(outcome.saved).toEqual([]);
    expect(outcome.failed[0]?.message).toContain("Update Uno Work");
  });
});
