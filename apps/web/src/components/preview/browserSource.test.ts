import { describe, expect, it } from "vitest";

import {
  availableBrowserSources,
  isDefaultBrowserSource,
  nextBrowserOpenIn,
  resolveBrowserOpenSource,
  showBrowserSourceChip,
} from "./browserSource";

describe("availableBrowserSources", () => {
  it("desktop app on a computer with a browser: both, the app first", () => {
    expect(availableBrowserSources({ desktopApp: true, computerBrowser: true })).toEqual([
      "app",
      "computer",
    ]);
  });

  it("the web build has only the computer's browser", () => {
    expect(availableBrowserSources({ desktopApp: false, computerBrowser: true })).toEqual([
      "computer",
    ]);
  });

  it("desktop app with a daemon that has no browser: only the app", () => {
    expect(availableBrowserSources({ desktopApp: true, computerBrowser: false })).toEqual(["app"]);
  });
});

describe("showBrowserSourceChip", () => {
  it("shows the chip only with two sources to choose from", () => {
    expect(showBrowserSourceChip(["app", "computer"])).toBe(true);
    expect(showBrowserSourceChip(["computer"])).toBe(false);
    expect(showBrowserSourceChip(["app"])).toBe(false);
    expect(showBrowserSourceChip([])).toBe(false);
  });
});

describe("resolveBrowserOpenSource", () => {
  const both = ["app", "computer"] as const;

  it("auto keeps the old rule: the computer's browser where the agents browse", () => {
    expect(
      resolveBrowserOpenSource({ setting: "auto", sources: both, agentsBrowseOnComputer: true }),
    ).toBe("computer");
    expect(
      resolveBrowserOpenSource({ setting: "auto", sources: both, agentsBrowseOnComputer: false }),
    ).toBe("app");
  });

  it("the person's default wins over the agents' place", () => {
    expect(
      resolveBrowserOpenSource({ setting: "app", sources: both, agentsBrowseOnComputer: true }),
    ).toBe("app");
    expect(
      resolveBrowserOpenSource({
        setting: "computer",
        sources: both,
        agentsBrowseOnComputer: false,
      }),
    ).toBe("computer");
  });

  it("a default this client doesn't have falls back to the old rule", () => {
    // "This app" chosen on the desktop, the same account in the web build.
    expect(
      resolveBrowserOpenSource({
        setting: "app",
        sources: ["computer"],
        agentsBrowseOnComputer: true,
      }),
    ).toBe("computer");
    // The computer's browser chosen, the daemon has none.
    expect(
      resolveBrowserOpenSource({
        setting: "computer",
        sources: ["app"],
        agentsBrowseOnComputer: false,
      }),
    ).toBe("app");
  });

  it("without the computer's browser it is the panel's own tab, as before", () => {
    expect(
      resolveBrowserOpenSource({ setting: "auto", sources: [], agentsBrowseOnComputer: false }),
    ).toBe("app");
  });
});

describe("Use by default", () => {
  it("is ticked only for the source the person chose", () => {
    expect(isDefaultBrowserSource("app", "app")).toBe(true);
    expect(isDefaultBrowserSource("auto", "app")).toBe(false);
    expect(isDefaultBrowserSource("computer", "app")).toBe(false);
  });

  it("ticking makes the source the default, unticking gives the choice back to auto", () => {
    expect(nextBrowserOpenIn("computer", true)).toBe("computer");
    expect(nextBrowserOpenIn("computer", false)).toBe("auto");
  });
});
