import { describe, expect, it } from "vitest";

import {
  isTypingTarget,
  type LauncherAppRow,
  type LauncherContext,
  LAUNCHER_TILES,
  launcherAppState,
  launcherKeyLabel,
  launcherTileForKey,
  sortLauncherApps,
  visibleLauncherTiles,
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

  it("the default browser carries the mark — only when there are two to choose from", () => {
    expect(tile(everything, "browser")?.isDefault).toBe(true);
    expect(tile(everything, "agentBrowser")?.isDefault).toBe(false);
    const computer = { ...everything, defaultBrowser: "computer" as const };
    expect(tile(computer, "browser")?.isDefault).toBe(false);
    expect(tile(computer, "agentBrowser")?.isDefault).toBe(true);
    const onlyHere = { ...everything, agentBrowserOn: null };
    expect(tile(onlyHere, "browser")?.isDefault).toBeUndefined();
  });

  it("the default browser goes first", () => {
    expect(ids({ ...everything, defaultBrowser: "computer" })).toEqual([
      "agentBrowser",
      "browser",
      "files",
      "changes",
      "apps",
    ]);
  });

  it("says what each browser is for, in plain words", () => {
    expect(tile(everything, "browser")?.description).toBe("Open the site here — you click");
    expect(tile(everything, "agentBrowser")?.description).toBe("Watch the agent in its browser");
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
