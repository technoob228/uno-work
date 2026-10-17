import { describe, expect, it } from "vitest";

import type { BrowserLivePage, BrowserLiveState } from "@t3tools/contracts";

import {
  afterComputerBrowserOpen,
  availableBrowserSources,
  browserSourceCopy,
  isDefaultBrowserSource,
  nextBrowserOpenIn,
  resolveBrowserOpenSource,
  shouldCloseSetupTabOnState,
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

  it("the new launcher: your site is always the default (Misha 16.10)", () => {
    for (const setting of ["auto", "app", "computer"] as const) {
      expect(
        resolveBrowserOpenSource({
          setting,
          sources: both,
          agentsBrowseOnComputer: true,
          siteFirst: true,
        }),
      ).toBe("app");
    }
    // The web build (no webview): the extension's tab, not the computer's browser.
    expect(
      resolveBrowserOpenSource({
        setting: "auto",
        sources: ["computer"],
        agentsBrowseOnComputer: true,
        siteFirst: true,
      }),
    ).toBe("app");
  });

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

describe("Browser on the computer: something visible at once", () => {
  const page = { pageId: "p1", url: "", title: "" } as unknown as BrowserLivePage;
  const state = (pages: BrowserLivePage[]) => ({ pages }) as unknown as BrowserLiveState;

  it("the machine is setting the browser up: its setup tab", () => {
    expect(afterComputerBrowserOpen({ resultPageId: "setup", state: state([]) })).toEqual({
      kind: "setup",
    });
  });

  it("the page is already in the machine's state: its tab opens right away", () => {
    expect(afterComputerBrowserOpen({ resultPageId: "p1", state: state([page]) })).toEqual({
      kind: "page",
      page,
    });
  });

  it("the page isn't in the state yet: the placeholder stays until it appears", () => {
    expect(afterComputerBrowserOpen({ resultPageId: "p1", state: state([]) })).toEqual({
      kind: "wait",
    });
    expect(afterComputerBrowserOpen({ resultPageId: "p1", state: null })).toEqual({
      kind: "wait",
    });
  });

  it("the placeholder opened while the browser was ready is not closed by the next update", () => {
    // Stand 15.10: the setup tab was closed on every "ready" snapshot.
    expect(shouldCloseSetupTabOnState("ready", "ready")).toBe(false);
  });

  it("the setup tab goes when the browser becomes ready, or is ready at the first look", () => {
    expect(shouldCloseSetupTabOnState("installing", "ready")).toBe(true);
    expect(shouldCloseSetupTabOnState("missing", "ready")).toBe(true);
    expect(shouldCloseSetupTabOnState(null, "ready")).toBe(true);
    expect(shouldCloseSetupTabOnState("ready", "installing")).toBe(false);
  });
});

describe("browserSourceCopy (the chip's words)", () => {
  it("flag panelLauncherV2 off: the words of 0.0.137", () => {
    const copy = browserSourceCopy(false);
    expect(copy.label).toEqual({ app: "This app", computer: "The computer's browser" });
    expect(copy.description.app).toBe("Right here in the panel, with your logins and phone sizes");
  });

  it("flag on: the launcher's two tiles", () => {
    const copy = browserSourceCopy(true);
    expect(copy.label).toEqual({ app: "Browser", computer: "Browser · agent's computer" });
  });
});
