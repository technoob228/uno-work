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
  agentBrowserOn: "uno-product",
  hasComputer: true,
  canOpenChanges: true,
};

const ids = (context: LauncherContext) => visibleLauncherTiles(context).map((tile) => tile.id);
const tile = (context: LauncherContext, id: string) =>
  visibleLauncherTiles(context).find((candidate) => candidate.id === id);

describe("visibleLauncherTiles", () => {
  it("a git project chat on a cloud computer: Your site first, then the agent's browser", () => {
    expect(ids(everything)).toEqual(["site", "agentBrowser", "files", "changes", "apps"]);
  });

  it("no Terminal tile: it opens at the bottom of the chat", () => {
    expect(ids(everything)).not.toContain("terminal");
  });

  it("two different tools, not one browser with a default: no default mark anywhere", () => {
    for (const shown of visibleLauncherTiles(everything)) {
      expect(shown).not.toHaveProperty("isDefault");
    }
  });

  it("says what each browser is for, in plain words", () => {
    expect(tile(everything, "site")?.name).toBe("Your site");
    expect(tile(everything, "site")?.description).toBe(
      "Open your site or app — comment and debug right on the page",
    );
    expect(tile(everything, "agentBrowser")?.name).toBe("Agent's browser");
    expect(tile(everything, "agentBrowser")?.description).toBe(
      "The browser on the agent's computer — sign in for it when it asks",
    );
  });

  it("a chat on this Mac: no Agent's browser, Your site still first", () => {
    expect(ids({ ...everything, agentBrowserOn: null })).toEqual([
      "site",
      "files",
      "changes",
      "apps",
    ]);
  });

  it("Your site and Apps are always there, even with nothing else", () => {
    expect(
      ids({
        agentBrowserOn: null,
        hasComputer: false,
        canOpenChanges: false,
      }),
    ).toEqual(["site", "apps"]);
  });

  it("no computer: no Files; not a git project: no Changes", () => {
    expect(ids({ ...everything, hasComputer: false })).not.toContain("files");
    expect(ids({ ...everything, canOpenChanges: false })).not.toContain("changes");
  });

  it("every tile has its own letter: S for the site, B for the agent's browser", () => {
    const keys = LAUNCHER_TILES.map(launcherKeyLabel);
    expect(new Set(keys).size).toBe(keys.length);
    expect(launcherKeyLabel(tile(everything, "site")!)).toBe("S");
    expect(launcherKeyLabel(tile(everything, "agentBrowser")!)).toBe("B");
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
    expect(key("s")).toBe("site");
    expect(key("b")).toBe("agentBrowser");
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
