/**
 * The right panel's launcher (plan 22, step 1): big tiles when the panel is
 * open with nothing in it, and from "+" in the tab strip. Each tile opens a
 * thing that already exists; a tile that would open nothing here is not shown
 * (no tiles turned off, no "coming soon"). Pure, so the rules are tested
 * directly.
 */

export type LauncherTileId = "browser" | "files" | "terminal" | "changes" | "apps" | "sites";

export interface LauncherTileCopy {
  readonly id: LauncherTileId;
  readonly name: string;
  /** One letter opens it while the launcher has focus (like t3's empty panel). */
  readonly key: string;
  readonly description: string;
}

/** Display order. */
export const LAUNCHER_TILES: ReadonlyArray<LauncherTileCopy> = [
  { id: "browser", name: "Browser", key: "B", description: "Open a website" },
  { id: "files", name: "Files", key: "F", description: "Browse the computer's files" },
  { id: "terminal", name: "Terminal", key: "T", description: "A command line in this project" },
  { id: "changes", name: "Changes", key: "C", description: "What changed in this project" },
  { id: "apps", name: "Apps", key: "A", description: "Apps on your computer" },
  { id: "sites", name: "Sites", key: "S", description: "Your sites on Uno" },
];

export interface LauncherContext {
  /** A browser to open: the companion/desktop browser, or the computer's (as "+ → Open page" before). */
  readonly canBrowse: boolean;
  /** A computer to browse files on. */
  readonly hasComputer: boolean;
  /** The chat on screen has a project (its terminal drawer). */
  readonly canOpenTerminal: boolean;
  /** The chat on screen is a saved chat in a git project (its Changes panel). */
  readonly canOpenChanges: boolean;
  /** Apps that open with one click, plus plugin panels. `null` — still loading. */
  readonly openableApps: number | null;
  /** The person's sites; `null` — Uno Hosting is unavailable here (or still loading). */
  readonly sites: number | null;
}

export function visibleLauncherTiles(context: LauncherContext): LauncherTileCopy[] {
  const shown: Record<LauncherTileId, boolean> = {
    browser: context.canBrowse,
    files: context.hasComputer,
    terminal: context.canOpenTerminal,
    changes: context.canOpenChanges,
    // While the list loads the tile stays: it opens the list, which says so.
    apps: context.openableApps === null || context.openableApps > 0,
    sites: context.sites !== null && context.sites > 0,
  };
  return LAUNCHER_TILES.filter((tile) => shown[tile.id]);
}

/** The tile a plain letter opens (no modifiers), or null. */
export function launcherTileForKey(
  tiles: ReadonlyArray<LauncherTileCopy>,
  event: {
    readonly key: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
  },
): LauncherTileId | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key.length !== 1) return null;
  const letter = event.key.toUpperCase();
  return tiles.find((tile) => tile.key === letter)?.id ?? null;
}
