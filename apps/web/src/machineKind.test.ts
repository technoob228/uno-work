import { describe, expect, it } from "vitest";

import {
  deriveMachineKind,
  machineKindFromPlatform,
  registryKindForMachineKind,
} from "./machineKind";

describe("deriveMachineKind", () => {
  it("trusts what the daemon reports over everything else", () => {
    expect(
      deriveMachineKind({
        descriptor: { machineKind: "uno_box", platform: { os: "linux", arch: "x64" } },
        registryKind: "local",
      }),
    ).toBe("uno_box");
    expect(
      deriveMachineKind({
        descriptor: { machineKind: "computer", platform: { os: "linux", arch: "x64" } },
        matchedBox: true,
      }),
    ).toBe("computer");
  });

  it("uses a box matched on the account before the registry's word", () => {
    expect(deriveMachineKind({ matchedBox: true, registryKind: "ssh" })).toBe("uno_box");
  });

  it("maps the registry kind when the daemon has not said", () => {
    expect(deriveMachineKind({ registryKind: "uno_box" })).toBe("uno_box");
    expect(deriveMachineKind({ registryKind: "local" })).toBe("computer");
    expect(deriveMachineKind({ registryKind: "ssh" })).toBe("server");
  });

  it("falls back to the platform: macOS and Windows are computers, the rest servers", () => {
    expect(deriveMachineKind({ descriptor: { platform: { os: "darwin", arch: "arm64" } } })).toBe(
      "computer",
    );
    expect(deriveMachineKind({ platformOs: "windows" })).toBe("computer");
    expect(deriveMachineKind({ platformOs: "linux" })).toBe("server");
    expect(deriveMachineKind({})).toBe("server");
  });

  it("prefers the descriptor's platform over a separately supplied one", () => {
    expect(
      deriveMachineKind({
        descriptor: { platform: { os: "darwin", arch: "arm64" } },
        platformOs: "linux",
      }),
    ).toBe("computer");
  });
});

describe("registryKindForMachineKind", () => {
  it("round-trips with the registry vocabulary", () => {
    expect(registryKindForMachineKind("uno_box")).toBe("uno_box");
    expect(registryKindForMachineKind("computer")).toBe("local");
    expect(registryKindForMachineKind("server")).toBe("ssh");
  });
});

describe("machineKindFromPlatform", () => {
  it("accepts both the descriptor and Node spellings of Windows", () => {
    expect(machineKindFromPlatform("windows")).toBe("computer");
    expect(machineKindFromPlatform("win32")).toBe("computer");
    expect(machineKindFromPlatform(null)).toBe("server");
  });
});
