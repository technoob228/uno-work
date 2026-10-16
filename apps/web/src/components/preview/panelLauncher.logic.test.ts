import { describe, expect, it } from "vitest";

import {
  isTypingTarget,
  type LauncherAppRow,
  type LauncherContext,
  LAUNCHER_TILES,
  type LegacyLauncherContext,
  launcherAppState,
  launcherKeyLabel,
  launcherTileForKey,
  legacyLauncherTileForKey,
  sortLauncherApps,
  visibleLauncherTiles,
  visibleLegacyLauncherTiles,
} from "./panelLauncher.logic";

const everything: LauncherContext = {
  canBrowseHere: true,
  agentBrowserOn: "uno-product",
  defaultBrowser: "app",
  hasComputer: true,
  canOpenChanges: true,
};

const ids = (context: LauncherContext) => visibleLauncherTiles(context).map((tile) => tile.id);
const tile = (context: LauncherContext, id: string) =>
  visibleLauncherTiles(context).find((candidate) => candidate.id === id);

describe("visibleLauncherTiles", () => {
  it("a git project chat on a cloud computer, in the desktop app: both browsers, in order", () => {
    expect(ids(everything)).toEqual(["browser", "agentBrowser", "files", "changes", "apps"]);
  });

  it("no Terminal tile: it opens at the bottom of the chat", () => {
    expect(ids(everything)).not.toContain("terminal");
  });

  it('no "default" mark on either browser (Misha 16.10)', () => {
    expect(tile(everything, "browser")?.isDefault).toBeUndefined();
    expect(tile(everything, "agentBrowser")?.isDefault).toBeUndefined();
  });

  it("your site goes first, whatever the browser setting says", () => {
    expect(ids({ ...everything, defaultBrowser: "computer" })).toEqual([
      "browser",
      "agentBrowser",
      "files",
      "changes",
      "apps",
    ]);
  });

  it("two different browsers, said in plain words", () => {
    expect(tile(everything, "browser")?.name).toBe("Your site");
    expect(tile(everything, "browser")?.description).toBe(
      "Open your site or app here — comment, see errors",
    );
    expect(tile(everything, "agentBrowser")?.name).toBe("Agent's browser");
    expect(tile(everything, "agentBrowser")?.description).toBe(
      "Watch the agent work; take control to sign in for it",
    );
  });

  it("the web build says honestly where your site opens", () => {
    expect(tile({ ...everything, desktop: false }, "browser")?.description).toBe(
      "Opens in a tab of this browser, with the Uno extension",
    );
  });

  it("a chat on this Mac: no Agent's browser", () => {
    expect(ids({ ...everything, agentBrowserOn: null })).not.toContain("agentBrowser");
  });

  it("the web build with no companion: only the agent's browser", () => {
    expect(ids({ ...everything, canBrowseHere: false })).toEqual([
      "agentBrowser",
      "files",
      "changes",
      "apps",
    ]);
  });

  it("Apps is always there, even with nothing else", () => {
    expect(
      ids({
        ...everything,
        canBrowseHere: false,
        agentBrowserOn: null,
        hasComputer: false,
        canOpenChanges: false,
      }),
    ).toEqual(["apps"]);
  });

  it("no computer: no Files; not a git project: no Changes", () => {
    expect(ids({ ...everything, hasComputer: false })).not.toContain("files");
    expect(ids({ ...everything, canOpenChanges: false })).not.toContain("changes");
  });

  it("every tile has its own key; the agent's browser is ⇧B", () => {
    const keys = LAUNCHER_TILES.map(launcherKeyLabel);
    expect(new Set(keys).size).toBe(keys.length);
    expect(launcherKeyLabel(tile(everything, "agentBrowser")!)).toBe("⇧B");
  });
});

describe("launcherTileForKey", () => {
  const tiles = visibleLauncherTiles(everything);
  const key = (
    k: string,
    mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
  ) =>
    launcherTileForKey(tiles, {
      key: k,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
    });

  it("one letter opens its tile, either case", () => {
    expect(key("b")).toBe("browser");
    expect(key("B", { shiftKey: true })).toBe("agentBrowser");
    expect(key("F")).toBe("files");
    expect(key("c")).toBe("changes");
    expect(key("a")).toBe("apps");
  });

  it("a letter of a hidden tile, a shortcut with a modifier, or another key does nothing", () => {
    const noChanges = visibleLauncherTiles({ ...everything, canOpenChanges: false });
    expect(
      launcherTileForKey(noChanges, { key: "c", metaKey: false, ctrlKey: false, altKey: false }),
    ).toBeNull();
    expect(key("b", { metaKey: true })).toBeNull();
    expect(key("b", { ctrlKey: true })).toBeNull();
    expect(key("Enter")).toBeNull();
    expect(key("t")).toBeNull();
    expect(key("F", { shiftKey: true })).toBeNull();
  });
});

describe("apps list", () => {
  const row = (patch: Partial<LauncherAppRow>): LauncherAppRow => ({
    key: patch.name ?? "x",
    name: "x",
    icon: null,
    iconImage: null,
    templateId: null,
    computer: "uno-work",
    state: "running",
    url: "https://x.example/",
    ...patch,
  });

  it("apps that open come first, then running ones, then the rest; by name inside", () => {
    const sorted = sortLauncherApps([
      row({ name: "Zeta", state: "stopped", url: null }),
      row({ name: "Beta" }),
      row({ name: "Gamma", url: null }),
      row({ name: "Alpha" }),
    ]);
    expect(sorted.map((r) => r.name)).toEqual(["Alpha", "Beta", "Gamma", "Zeta"]);
  });

  it("a program's status in the list's three words", () => {
    expect(launcherAppState("running")).toBe("running");
    expect(launcherAppState("asleep")).toBe("asleep");
    expect(launcherAppState("failed")).toBe("stopped");
    expect(launcherAppState("stopped")).toBe("stopped");
  });
});

describe("isTypingTarget", () => {
  it("letters reach the launcher from the Panel button or from nowhere", () => {
    expect(isTypingTarget({ tagName: "BUTTON", isContentEditable: false })).toBe(false);
    expect(isTypingTarget({ tagName: "BODY", isContentEditable: false })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("not while the person types: inputs, the terminal's textarea, the composer", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "textarea" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });
});

// ── Flag `panelLauncherV2` off: the launcher of 0.0.137, same expectations ──

describe("flag off: the 0.0.137 launcher", () => {
  const legacyEverything: LegacyLauncherContext = {
    canBrowse: true,
    hasComputer: true,
    canOpenTerminal: true,
    canOpenChanges: true,
    openableApps: 2,
    sites: 1,
  };
  const legacyIds = (context: LegacyLauncherContext) =>
    visibleLegacyLauncherTiles(context).map((tile) => tile.id);

  describe("visibleLegacyLauncherTiles", () => {
    it("a git project chat with apps and sites: all six, in order", () => {
      expect(legacyIds(legacyEverything)).toEqual([
        "browser",
        "files",
        "terminal",
        "changes",
        "apps",
        "sites",
      ]);
    });

    it("no project: no Terminal, no Changes", () => {
      expect(
        legacyIds({ ...legacyEverything, canOpenTerminal: false, canOpenChanges: false }),
      ).toEqual(["browser", "files", "apps", "sites"]);
    });

    it("a project that is not git: Terminal, but no Changes", () => {
      expect(legacyIds({ ...legacyEverything, canOpenChanges: false })).toContain("terminal");
      expect(legacyIds({ ...legacyEverything, canOpenChanges: false })).not.toContain("changes");
    });

    it("no browser to open: no Browser tile", () => {
      expect(legacyIds({ ...legacyEverything, canBrowse: false })).not.toContain("browser");
    });

    it("Apps shows while its list loads, hides when nothing opens", () => {
      expect(legacyIds({ ...legacyEverything, openableApps: null })).toContain("apps");
      expect(legacyIds({ ...legacyEverything, openableApps: 0 })).not.toContain("apps");
    });

    it("Sites hides with no sites or no Uno Hosting here", () => {
      expect(legacyIds({ ...legacyEverything, sites: 0 })).not.toContain("sites");
      expect(legacyIds({ ...legacyEverything, sites: null })).not.toContain("sites");
    });

    it("no computer: no Files", () => {
      expect(legacyIds({ ...legacyEverything, hasComputer: false })).not.toContain("files");
    });
  });

  describe("legacyLauncherTileForKey", () => {
    const tiles = visibleLegacyLauncherTiles(legacyEverything);
    const key = (
      k: string,
      mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {},
    ) =>
      legacyLauncherTileForKey(tiles, {
        key: k,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        ...mods,
      });

    it("one letter opens its tile, either case", () => {
      expect(key("b")).toBe("browser");
      expect(key("F")).toBe("files");
      expect(key("t")).toBe("terminal");
      expect(key("c")).toBe("changes");
      expect(key("a")).toBe("apps");
      expect(key("s")).toBe("sites");
    });

    it("a letter of a hidden tile, a shortcut with a modifier, or another key does nothing", () => {
      const noChanges = visibleLegacyLauncherTiles({ ...legacyEverything, canOpenChanges: false });
      expect(
        legacyLauncherTileForKey(noChanges, {
          key: "c",
          metaKey: false,
          ctrlKey: false,
          altKey: false,
        }),
      ).toBeNull();
      expect(key("b", { metaKey: true })).toBeNull();
      expect(key("b", { ctrlKey: true })).toBeNull();
      expect(key("Enter")).toBeNull();
      expect(key("x")).toBeNull();
    });
  });
});
