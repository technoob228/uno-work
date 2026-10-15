import { describe, expect, it } from "vitest";

import {
  type LauncherContext,
  launcherTileForKey,
  visibleLauncherTiles,
} from "./panelLauncher.logic";

const everything: LauncherContext = {
  canBrowse: true,
  hasComputer: true,
  canOpenTerminal: true,
  canOpenChanges: true,
  openableApps: 2,
  sites: 1,
};

const ids = (context: LauncherContext) => visibleLauncherTiles(context).map((tile) => tile.id);

describe("visibleLauncherTiles", () => {
  it("a git project chat with apps and sites: all six, in order", () => {
    expect(ids(everything)).toEqual(["browser", "files", "terminal", "changes", "apps", "sites"]);
  });

  it("no project: no Terminal, no Changes", () => {
    expect(ids({ ...everything, canOpenTerminal: false, canOpenChanges: false })).toEqual([
      "browser",
      "files",
      "apps",
      "sites",
    ]);
  });

  it("a project that is not git: Terminal, but no Changes", () => {
    expect(ids({ ...everything, canOpenChanges: false })).toContain("terminal");
    expect(ids({ ...everything, canOpenChanges: false })).not.toContain("changes");
  });

  it("no browser to open: no Browser tile", () => {
    expect(ids({ ...everything, canBrowse: false })).not.toContain("browser");
  });

  it("Apps shows while its list loads, hides when nothing opens", () => {
    expect(ids({ ...everything, openableApps: null })).toContain("apps");
    expect(ids({ ...everything, openableApps: 0 })).not.toContain("apps");
  });

  it("Sites hides with no sites or no Uno Hosting here", () => {
    expect(ids({ ...everything, sites: 0 })).not.toContain("sites");
    expect(ids({ ...everything, sites: null })).not.toContain("sites");
  });

  it("no computer: no Files", () => {
    expect(ids({ ...everything, hasComputer: false })).not.toContain("files");
  });
});

describe("launcherTileForKey", () => {
  const tiles = visibleLauncherTiles(everything);
  const key = (
    k: string,
    mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {},
  ) =>
    launcherTileForKey(tiles, { key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });

  it("one letter opens its tile, either case", () => {
    expect(key("b")).toBe("browser");
    expect(key("F")).toBe("files");
    expect(key("t")).toBe("terminal");
    expect(key("c")).toBe("changes");
    expect(key("a")).toBe("apps");
    expect(key("s")).toBe("sites");
  });

  it("a letter of a hidden tile, a shortcut with a modifier, or another key does nothing", () => {
    const noChanges = visibleLauncherTiles({ ...everything, canOpenChanges: false });
    expect(
      launcherTileForKey(noChanges, { key: "c", metaKey: false, ctrlKey: false, altKey: false }),
    ).toBeNull();
    expect(key("b", { metaKey: true })).toBeNull();
    expect(key("b", { ctrlKey: true })).toBeNull();
    expect(key("Enter")).toBeNull();
    expect(key("x")).toBeNull();
  });
});
