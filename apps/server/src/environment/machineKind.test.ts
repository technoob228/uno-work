import { describe, expect, it } from "vitest";

import {
  looksLikeUnoBoxHostname,
  parseUnoBoxIdFromEnvironment,
  resolveMachineKind,
  type MachineKindSignals,
} from "./machineKind.ts";

const base: MachineKindSignals = {
  mode: "web",
  platform: "linux",
  hostname: "vm-1234",
  unoBoxId: null,
};

describe("resolveMachineKind", () => {
  it("is an Uno box whenever the daemon knows its box id, regardless of platform", () => {
    expect(resolveMachineKind({ ...base, unoBoxId: 395 })).toEqual({
      machineKind: "uno_box",
      unoBoxId: 395,
    });
    expect(
      resolveMachineKind({ ...base, unoBoxId: 7, mode: "desktop", platform: "darwin" }),
    ).toEqual({ machineKind: "uno_box", unoBoxId: 7 });
  });

  it("falls back to box hostnames when the id is unknown, without inventing an id", () => {
    expect(resolveMachineKind({ ...base, hostname: "box-395.uno4.dev" })).toEqual({
      machineKind: "uno_box",
    });
    expect(resolveMachineKind({ ...base, hostname: "unowork-golden-build" })).toEqual({
      machineKind: "uno_box",
    });
  });

  it("is a computer under the desktop app or on macOS/Windows", () => {
    expect(resolveMachineKind({ ...base, mode: "desktop" }).machineKind).toBe("computer");
    expect(resolveMachineKind({ ...base, platform: "darwin" }).machineKind).toBe("computer");
    expect(resolveMachineKind({ ...base, platform: "win32" }).machineKind).toBe("computer");
  });

  it("is a server otherwise", () => {
    expect(resolveMachineKind(base).machineKind).toBe("server");
    expect(resolveMachineKind({ ...base, platform: "freebsd" }).machineKind).toBe("server");
  });
});

describe("looksLikeUnoBoxHostname", () => {
  it("matches the box image hostnames only", () => {
    expect(looksLikeUnoBoxHostname("Box-1.UNO4.dev")).toBe(true);
    expect(looksLikeUnoBoxHostname("unowork-golden-v7")).toBe(true);
    expect(looksLikeUnoBoxHostname("mikhails-macbook.local")).toBe(false);
    expect(looksLikeUnoBoxHostname("")).toBe(false);
    expect(looksLikeUnoBoxHostname("uno4.dev.example.com")).toBe(false);
  });
});

describe("parseUnoBoxIdFromEnvironment", () => {
  it("accepts a positive integer and nothing else", () => {
    expect(parseUnoBoxIdFromEnvironment("395")).toBe(395);
    expect(parseUnoBoxIdFromEnvironment(" 12 ")).toBe(12);
    expect(parseUnoBoxIdFromEnvironment("0")).toBeNull();
    expect(parseUnoBoxIdFromEnvironment("-3")).toBeNull();
    expect(parseUnoBoxIdFromEnvironment("abc")).toBeNull();
    expect(parseUnoBoxIdFromEnvironment(undefined)).toBeNull();
  });
});
