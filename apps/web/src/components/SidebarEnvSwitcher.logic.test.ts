import { describe, expect, it } from "vitest";
import type { EnvironmentId } from "@t3tools/contracts";

import { groupSwitcherMachines, type SwitcherMachine } from "./SidebarEnvSwitcher.logic";

function machine(
  id: string,
  overrides: Partial<Omit<SwitcherMachine, "id">> = {},
): SwitcherMachine {
  return {
    id: id as EnvironmentId,
    name: id,
    meta: "",
    kind: "server",
    connectionState: "connected",
    isPrimary: false,
    isDefault: false,
    ...overrides,
  };
}

describe("groupSwitcherMachines", () => {
  it("groups by kind with plain headings and leaves empty groups out", () => {
    const groups = groupSwitcherMachines([
      machine("outreach-machine", { kind: "uno_box" }),
      machine("unowork-golden-build", { kind: "uno_box", isPrimary: true }),
      machine("vps", { kind: "server" }),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["Uno boxes", "Other machines"]);
    expect(groups.map((group) => group.items.map((item) => item.name))).toEqual([
      ["outreach-machine", "unowork-golden-build"],
      ["vps"],
    ]);
  });

  it("never invents a heading from the daemon's role", () => {
    const groups = groupSwitcherMachines([
      machine("box", { kind: "uno_box", isPrimary: true }),
      machine("laptop", { kind: "computer" }),
    ]);
    for (const group of groups) {
      expect(group.label).not.toMatch(/this computer/iu);
    }
    expect(groups.map((group) => group.label)).toEqual(["Uno boxes", "Your computers"]);
  });

  it("puts the default machine first: its group leads and it leads its group", () => {
    const groups = groupSwitcherMachines([
      machine("box", { kind: "uno_box", isPrimary: true }),
      machine("zeta-server", { kind: "server", isDefault: true }),
      machine("alpha-server", { kind: "server" }),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["Other machines", "Uno boxes"]);
    expect(groups[0]?.items.map((item) => item.name)).toEqual(["zeta-server", "alpha-server"]);
  });

  it("keeps the fixed kind order when nothing is the default", () => {
    const groups = groupSwitcherMachines([
      machine("vps", { kind: "server" }),
      machine("laptop", { kind: "computer" }),
      machine("box", { kind: "uno_box" }),
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["uno_box", "computer", "server"]);
  });
});
