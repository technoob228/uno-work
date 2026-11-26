import { describe, expect, it } from "vitest";

import { cloudCopyMaker, desktopWouldDropPassword } from "./desktopFileShare";

describe("cloudCopyMaker", () => {
  it("lets the desktop app upload a file of this Mac", () => {
    expect(cloudCopyMaker({ isElectron: true, onThisComputer: true, bridgeHasDrive: true })).toBe(
      "desktop",
    );
  });

  it("keeps the daemon for cloud computers, the web and older desktop apps", () => {
    expect(cloudCopyMaker({ isElectron: true, onThisComputer: false, bridgeHasDrive: true })).toBe(
      "daemon",
    );
    expect(cloudCopyMaker({ isElectron: false, onThisComputer: true, bridgeHasDrive: false })).toBe(
      "daemon",
    );
    expect(cloudCopyMaker({ isElectron: true, onThisComputer: true, bridgeHasDrive: false })).toBe(
      "daemon",
    );
  });
});

describe("desktopWouldDropPassword", () => {
  it("stops a password link through a desktop app that can't pass the password on", () => {
    expect(desktopWouldDropPassword("brave-otter-42", {})).toBe(true);
    expect(desktopWouldDropPassword("brave-otter-42", { sharePassword: true })).toBe(false);
    expect(desktopWouldDropPassword(undefined, {})).toBe(false);
    expect(desktopWouldDropPassword("", {})).toBe(false);
  });
});
