import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  APP_NAV_GROUP_HEADING,
  buildSettingsNavGroups,
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
