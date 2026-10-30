import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import {
  effectiveScopeSearch,
  projectsForComputer,
  resolveSettingsScope,
  selectComputerAxis,
  selectProjectAxis,
  validateSettingsScopeSearch,
} from "./settingsScope";

const mac = "env-mac" as EnvironmentId;
const box = "env-box" as EnvironmentId;
const environments = [
  { environmentId: mac, label: "Mainbook" },
  { environmentId: box, label: "uno-work" },
];
const group = {
  projectKey: "shop",
  displayName: "shop",
  memberProjects: [
    { id: "p-mac", environmentId: mac, physicalProjectKey: "mac:p" },
    { id: "p-box", environmentId: box, physicalProjectKey: "box:p" },
  ],
} as unknown as SidebarProjectSnapshot;
const macOnly = {
  projectKey: "notes",
  displayName: "notes",
  memberProjects: [{ id: "n-mac", environmentId: mac, physicalProjectKey: "mac:n" }],
} as unknown as SidebarProjectSnapshot;

describe("resolveSettingsScope", () => {
  it("is every computer when nothing is picked", () => {
    const scope = resolveSettingsScope({}, [group], environments);
    expect(scope.kind).toBe("all");
    expect(scope.environmentIds).toEqual([mac, box]);
  });

  it("targets every computer a project is on", () => {
    const scope = resolveSettingsScope({ project: "shop" }, [group], environments);
    expect(scope.kind).toBe("project");
    expect(scope.members.map((member) => member.id)).toEqual(["p-mac", "p-box"]);
    expect(scope.environmentIds).toEqual([mac, box]);
  });

  it("narrows a project to one computer", () => {
    const scope = resolveSettingsScope({ project: "shop", machine: box }, [group], environments);
    expect(scope.members.map((member) => member.id)).toEqual(["p-box"]);
    expect(scope.environmentIds).toEqual([box]);
  });

  it("never widens a stale id to everything", () => {
    expect(resolveSettingsScope({ machine: "gone" }, [group], environments).kind).toBe(
      "unavailable",
    );
    expect(resolveSettingsScope({ project: "gone" }, [group], environments).kind).toBe(
      "unavailable",
    );
    const missing = resolveSettingsScope(
      { project: "notes", machine: box },
      [macOnly],
      environments,
    );
    expect(missing.kind).toBe("unavailable");
    expect(missing.environmentIds).toEqual([]);
  });
});

describe("effectiveScopeSearch", () => {
  it("takes the computer from the path on machine pages", () => {
    expect(effectiveScopeSearch({ project: "shop" }, mac)).toEqual({
      project: "shop",
      machine: mac,
    });
  });

  it("lets only the explicit all widen a machine page", () => {
    expect(effectiveScopeSearch({ machine: "all" }, mac)).toEqual({});
    expect(effectiveScopeSearch({ machine: box }, mac)).toEqual({ machine: mac });
  });

  it("keeps the search on pages without a computer in the path", () => {
    expect(effectiveScopeSearch({ machine: box }, null)).toEqual({ machine: box });
    expect(effectiveScopeSearch({ machine: "all" }, null)).toEqual({});
  });
});

describe("axes", () => {
  it("keeps the other axis when one changes", () => {
    expect(selectComputerAxis({ project: "shop" }, box)).toEqual({ project: "shop", machine: box });
    expect(selectProjectAxis({ machine: box }, "shop")).toEqual({ project: "shop", machine: box });
    expect(selectProjectAxis({ project: "shop", machine: box }, "all")).toEqual({ machine: box });
  });

  it("lists only the projects on the chosen computer", () => {
    expect(projectsForComputer([group, macOnly], box)).toEqual([group]);
    expect(projectsForComputer([group, macOnly], undefined)).toEqual([group, macOnly]);
  });

  it("drops empty search values", () => {
    expect(validateSettingsScopeSearch({ project: " ", machine: 3 })).toEqual({});
  });
});
