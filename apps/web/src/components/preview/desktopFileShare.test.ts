import { describe, expect, it } from "vitest";

import { cloudCopyMaker } from "./desktopFileShare";

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
