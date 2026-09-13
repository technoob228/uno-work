import { describe, expect, it } from "vitest";
import type { EnvironmentId, UnoBox, WorkspaceMachine } from "@t3tools/contracts";

import { boxStatus, buildMachineRows, formatRelativeTime, registryIdForBox } from "./machineRows";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const primary = "env-local" as EnvironmentId;

/** Rows other than the daemon serving the UI, which is always listed first. */
const others = (rows: ReturnType<typeof buildMachineRows>) => rows.filter((row) => !row.isPrimary);

function machine(
  overrides: Omit<Partial<WorkspaceMachine>, "environmentId"> & { environmentId: string },
): WorkspaceMachine {
  return {
    label: overrides.environmentId,
    kind: "ssh",
    unoBoxId: null,
    lastSeenAt: null,
    monogram: "XX",
    colorSlot: 0,
    ...overrides,
    environmentId: overrides.environmentId as EnvironmentId,
  } as WorkspaceMachine;
}

function box(overrides: Partial<UnoBox> & { id: number; name: string }): UnoBox {
  return {
    status: "running",
    os: "ubuntu",
    ramMb: 4096,
    vcpu: 2,
    diskGb: 40,
    ssh: null,
    publicIp: null,
    internalIp: null,
    createdAt: null,
    ...overrides,
  } as UnoBox;
}

describe("buildMachineRows", () => {
  it("lists this computer first, always online, and never removable", () => {
    const rows = buildMachineRows({
      primaryEnvironmentId: primary,
      registryMachines: [
        machine({ environmentId: "env-b", label: "Zed", kind: "ssh" }),
        machine({ environmentId: primary, label: "This machine", kind: "local" }),
      ],
      savedEnvironments: [],
      connectionStateById: {},
      boxes: [],
      projectNamesByEnvironmentId: new Map(),
      now: NOW,
    });
    expect(rows.map((row) => row.label)).toEqual(["This machine", "Zed"]);
    expect(rows[0]).toMatchObject({ isPrimary: true, status: "online", kind: "computer" });
    expect(rows[1]?.kind).toBe("server");
  });

  it("takes the kind from what each daemon reports, not from its role", () => {
    const rows = buildMachineRows({
      primaryEnvironmentId: primary,
      descriptorById: {
        [primary]: { machineKind: "uno_box", unoBoxId: 395 },
        "env-laptop": { machineKind: "computer" },
      },
      registryMachines: [
        // The registry still says "local" for the daemon that registered
        // itself — the descriptor wins.
        machine({ environmentId: primary, label: "unowork-golden-build", kind: "local" }),
        machine({ environmentId: "env-laptop", label: "MacBook", kind: "ssh" }),
      ],
      savedEnvironments: [],
      connectionStateById: {},
      boxes: [],
      projectNamesByEnvironmentId: new Map(),
      now: NOW,
    });
    const byLabel = new Map(rows.map((row) => [row.label, row]));
    expect(byLabel.get("unowork-golden-build")?.kind).toBe("uno_box");
    expect(byLabel.get("MacBook")?.kind).toBe("computer");
  });

  it("matches the box by the id the daemon reports before any name match", () => {
    const mine = box({ id: 395, name: "renamed-in-console" });
    const rows = buildMachineRows({
      primaryEnvironmentId: primary,
      primaryLabel: "unowork-golden-build",
      descriptorById: { [primary]: { machineKind: "uno_box", unoBoxId: 395 } },
      registryMachines: [],
      savedEnvironments: [],
      connectionStateById: {},
      boxes: [mine],
      projectNamesByEnvironmentId: new Map(),
      now: NOW,
    });
    // One row, not "this machine" plus a separate unconnected box.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isPrimary: true, kind: "uno_box", box: mine });
  });

  it("lists the chosen default machine first and flags it", () => {
    const rows = buildMachineRows({
      primaryEnvironmentId: primary,
      defaultEnvironmentId: "env-b" as EnvironmentId,
      registryMachines: [
        machine({ environmentId: primary, label: "Box", kind: "local" }),
        machine({ environmentId: "env-b", label: "Laptop", kind: "ssh" }),
        machine({ environmentId: "env-c", label: "Alpha", kind: "ssh" }),
      ],
      savedEnvironments: [],
      connectionStateById: {},
      boxes: [],
      projectNamesByEnvironmentId: new Map(),
      now: NOW,
    });
    expect(rows.map((row) => row.label)).toEqual(["Laptop", "Box", "Alpha"]);
    expect(rows.map((row) => row.isDefault)).toEqual([true, false, false]);
  });

  it("reads status from the live connection before registry presence", () => {
    const rows = buildMachineRows({
      primaryEnvironmentId: primary,
      registryMachines: [
        machine({
          environmentId: "env-stale",
          label: "Stale but connected",
          lastSeenAt: new Date(NOW - 60 * 60_000).toISOString(),
        }),
        machine({
          environmentId: "env-fresh",
          label: "Fresh but no connection",
          lastSeenAt: new Date(NOW - 10_000).toISOString(),
        }),
        machine({ environmentId: "env-never", label: "Never seen" }),
      ],
      savedEnvironments: [],
      connectionStateById: { "env-stale": "connected" },
      boxes: [],
      projectNamesByEnvironmentId: new Map(),
      now: NOW,
    });
    const byLabel = new Map(rows.map((row) => [row.label, row]));
    expect(byLabel.get("Stale but connected")?.status).toBe("online");
    expect(byLabel.get("Fresh but no connection")?.status).toBe("online");
    expect(byLabel.get("Never seen")?.status).toBe("unknown");
    expect(byLabel.get("Never seen")?.detail).toBe("seen never");
  });

  it("attaches the control-plane box to an adopted registry entry and reports sleeping", () => {
    const sleeping = box({ id: 7, name: "hk-box", status: "stopped" });
    const rows = buildMachineRows({
      primaryEnvironmentId: primary,
      registryMachines: [
        machine({
          environmentId: registryIdForBox(7),
          label: "hk-box",
          kind: "uno_box",
          unoBoxId: 7,
        }),
      ],
      savedEnvironments: [],
      connectionStateById: {},
      boxes: [sleeping],
      projectNamesByEnvironmentId: new Map(),
      now: NOW,
    });
    expect(others(rows)).toHaveLength(1);
    expect(others(rows)[0]).toMatchObject({
      kind: "uno_box",
      status: "sleeping",
      box: sleeping,
      inRegistry: true,
      detail: "2 vCPU · 4 GB · 40 GB disk",
    });
  });

  it("matches a saved connection to a box by name instead of listing it twice", () => {
    const running = box({ id: 3, name: "Dev Box" });
    const rows = buildMachineRows({
      primaryEnvironmentId: primary,
      registryMachines: [],
      savedEnvironments: [
        { environmentId: "env-devbox" as EnvironmentId, label: "dev box", lastConnectedAt: null },
      ],
      connectionStateById: { "env-devbox": "connected" },
      boxes: [running],
      projectNamesByEnvironmentId: new Map([["env-devbox", ["site", "api"]]]),
      now: NOW,
    });
    expect(others(rows)).toHaveLength(1);
    expect(others(rows)[0]).toMatchObject({
      environmentId: "env-devbox",
      kind: "uno_box",
      status: "online",
      box: running,
      isSavedConnection: true,
      inRegistry: false,
      projects: ["site", "api"],
    });
  });

  it("shows an unconnected box from the account as a row with no environment", () => {
    const rows = buildMachineRows({
      primaryEnvironmentId: primary,
      registryMachines: [],
      savedEnvironments: [],
      connectionStateById: {},
      boxes: [box({ id: 9, name: "spare", status: "error" })],
      projectNamesByEnvironmentId: new Map(),
      now: NOW,
    });
    expect(others(rows)[0]).toMatchObject({
      environmentId: null,
      key: "box:9",
      kind: "uno_box",
      status: "offline",
      inRegistry: false,
      isSavedConnection: false,
    });
    expect(others(rows)[0]?.identity.environmentId).toBe("uno-box-9");
  });

  it("describes a connection in progress instead of calling it offline silently", () => {
    const rows = buildMachineRows({
      primaryEnvironmentId: primary,
      registryMachines: [],
      savedEnvironments: [
        { environmentId: "env-r" as EnvironmentId, label: "remote", lastConnectedAt: null },
      ],
      connectionStateById: { "env-r": "reconnecting" },
      boxes: [],
      projectNamesByEnvironmentId: new Map(),
      now: NOW,
    });
    expect(others(rows)[0]).toMatchObject({
      status: "offline",
      detail: "Reconnecting…",
      // Never answered, so nothing says what it is: "Other machine".
      kind: "server",
    });
  });
});

describe("buildMachineRows — primary machine", () => {
  it("always lists the daemon serving the UI, even before anything is registered", () => {
    const rows = buildMachineRows({
      primaryEnvironmentId: "env-primary" as EnvironmentId,
      primaryLabel: "Mikhail's laptop",
      descriptorById: {
        "env-primary": { platform: { os: "darwin", arch: "arm64" } },
      },
      registryMachines: [],
      savedEnvironments: [],
      connectionStateById: {},
      boxes: [],
      projectNamesByEnvironmentId: new Map([["env-primary", ["site"]]]),
      now: Date.now(),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      environmentId: "env-primary",
      label: "Mikhail's laptop",
      // An older daemon that does not report its kind: macOS means a computer.
      kind: "computer",
      status: "online",
      isPrimary: true,
      projects: ["site"],
    });
  });

  it("falls back to a generic label when the server config is not hydrated yet", () => {
    const rows = buildMachineRows({
      primaryEnvironmentId: "env-primary" as EnvironmentId,
      registryMachines: [],
      savedEnvironments: [],
      connectionStateById: {},
      boxes: [],
      projectNamesByEnvironmentId: new Map(),
      now: Date.now(),
    });
    // Not "This computer": the daemon serving the page may well be a box.
    expect(rows[0]?.label).toBe("This machine");
  });
});

describe("boxStatus", () => {
  it("maps control-plane words onto the three user-facing states", () => {
    expect(boxStatus(box({ id: 1, name: "a", status: "running" }))).toBe("online");
    expect(boxStatus(box({ id: 1, name: "a", status: "Stopped" }))).toBe("sleeping");
    expect(boxStatus(box({ id: 1, name: "a", status: "suspended" }))).toBe("sleeping");
    expect(boxStatus(box({ id: 1, name: "a", status: "error" }))).toBe("offline");
    expect(boxStatus(box({ id: 1, name: "a", status: "provisioning" }))).toBe("offline");
  });
});

describe("formatRelativeTime", () => {
  it("rounds to the largest sensible unit", () => {
    expect(formatRelativeTime(null, NOW)).toBe("never");
    expect(formatRelativeTime(new Date(NOW - 5_000).toISOString(), NOW)).toBe("5s ago");
    expect(formatRelativeTime(new Date(NOW - 90_000).toISOString(), NOW)).toBe("2m ago");
    expect(formatRelativeTime(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe("3h ago");
    expect(formatRelativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe("2d ago");
    expect(formatRelativeTime("not a date", NOW)).toBe("unknown");
  });
});
