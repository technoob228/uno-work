import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  APP_NAV_GROUP_HEADING,
  buildSettingsNavGroups,
  isSimpleSettingsPath,
  machineNavGroupHeading,
} from "./settingsNavGroups.ts";

const BOX = { environmentId: "env-box" as EnvironmentId, label: "Office box" };
const allFlagsOn = () => true;

describe("buildSettingsNavGroups", () => {
  it("splits entries into this app and the machine being configured", () => {
    const groups = buildSettingsNavGroups({
      isWebApp: false,
      isFlagEnabled: allFlagsOn,
      machine: BOX,
    });

    expect(groups.map((group) => group.heading)).toEqual([
      APP_NAV_GROUP_HEADING,
      "Machine: Office box",
    ]);

    const [app, machine] = groups;
    expect(app!.entries.map((entry) => entry.to)).toEqual([
      "/settings/app/general",
      "/settings/app/connections",
      "/settings/app/phone",
      "/settings/app/browser",
      "/settings/app/labs",
      "/settings/vault",
      "/settings/workspace",
      "/settings/computer-access",
      "/settings/security",
      "/settings/extensions",
    ]);
    expect(machine!.entries.map((entry) => entry.to)).toEqual([
      "/settings/environment/env-box/general",
      "/settings/environment/env-box/providers",
      "/settings/environment/env-box/harnesses",
      "/settings/environment/env-box/assistants",
      "/settings/environment/env-box/apps",
      "/settings/environment/env-box/source-control",
      "/settings/environment/env-box/archived",
    ]);
  });

  it("shows only the app group before any machine is known", () => {
    const groups = buildSettingsNavGroups({
      isWebApp: false,
      isFlagEnabled: allFlagsOn,
      machine: null,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("app");
  });

  it("hides flagged entries when their flag is off", () => {
    const groups = buildSettingsNavGroups({
      isWebApp: false,
      isFlagEnabled: (flag) => flag === undefined,
      machine: BOX,
    });

    expect(groups[0]!.entries.map((entry) => entry.label)).toEqual([
      "General",
      "Connections",
      "Phone",
      "Labs",
      "My machines",
      "Computer access",
      "Security",
    ]);
  });

  it("calls the machine's general page the account in the browser build", () => {
    const groups = buildSettingsNavGroups({
      isWebApp: true,
      isFlagEnabled: allFlagsOn,
      machine: BOX,
    });

    const machine = groups[1]!;
    expect(machine.entries[0]).toMatchObject({
      label: "Account",
      to: "/settings/environment/env-box/general",
    });
  });

  it("names the machine in plain words", () => {
    expect(machineNavGroupHeading("Home Mac")).toBe("Machine: Home Mac");
  });
});

describe("simple settings (01.10)", () => {
  it("shows five entries without Dev mode", () => {
    const groups = buildSettingsNavGroups({
      isWebApp: true,
      isFlagEnabled: allFlagsOn,
      machine: BOX,
      mode: "simple",
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map((entry) => entry.label)).toEqual([
      "Account & plan",
      "AI",
      "Assistants & phone",
      "Computer",
      "Developer",
    ]);
  });

  it("puts everything after the five in Dev mode", () => {
    const groups = buildSettingsNavGroups({
      isWebApp: false,
      isFlagEnabled: allFlagsOn,
      machine: BOX,
      mode: "developer",
    });
    expect(groups.map((group) => group.kind)).toEqual(["simple", "app", "machine"]);
    expect(groups[1]!.entries.map((entry) => entry.label)).toContain("Labs");
    expect(groups[2]!.entries.map((entry) => entry.label)).toContain("Harnesses");
  });

  it("knows its pages", () => {
    expect(isSimpleSettingsPath("/settings/ai")).toBe(true);
    expect(isSimpleSettingsPath("/settings/app/general")).toBe(false);
  });
});
