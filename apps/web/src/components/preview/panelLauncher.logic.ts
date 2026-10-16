/**
 * The right panel's launcher (plan 22, step 1; w0138): big tiles when the
 * panel is open with nothing in it, and from "+" in the tab strip. Each tile
 * opens a thing that already exists. Pure, so the rules are tested directly.
 *
 *   - Your site        — always first: the person opens their site or app
 *                        right in the panel and comments on it / debugs it
 *                        (one Comment button, like Codex). Not a setting,
 *                        not a choice between browsers (Misha 16.10).
 *   - Agent's browser  — a different tool: the browser on the chat's cloud
 *                        computer. The agent works there; the person signs
 *                        in for it when it asks (login, captcha, 2FA).
 *   - Files, Changes   — as before.
 *   - Apps             — always: the person's apps on every computer and
 *                        their sites, with an empty state that says how to
 *                        get one.
 *
 * The terminal is not here: it opens at the bottom of the chat (Ctrl+`), and
 * a tile that opened something somewhere else confused people (16.10).
 *
 * Behind Labs `panelLauncherV2`; without it — the launcher of 0.0.137 (the
 * "Legacy" part at the end, `LegacyPanelLauncher.tsx`).
 */
import type { ProgramStatus } from "../computer/programModel";

export type LauncherTileId = "site" | "agentBrowser" | "files" | "changes" | "apps";

export interface LauncherTileCopy {
  readonly id: LauncherTileId;
  readonly name: string;
  /** The letter that opens it while the launcher has focus (like t3's empty panel). */
  readonly key: string;
  readonly description: string;
}

/** Display order: Your site is always first, the agent's browser last. */
export const LAUNCHER_TILES: ReadonlyArray<LauncherTileCopy> = [
  {
    id: "site",
    name: "Your site",
    key: "S",
    description: "Open your site or app — comment and debug right on the page",
  },
  { id: "files", name: "Files", key: "F", description: "Browse the computer's files" },
  { id: "changes", name: "Changes", key: "C", description: "What the agent changed" },
  { id: "apps", name: "Apps", key: "A", description: "Your apps and sites" },
  // Secondary (Misha 16.10, 21:15): your browser is the default; the agent's
  // browser comes last and quieter.
  {
    id: "agentBrowser",
    name: "Agent's browser",
    key: "B",
    description: "The browser on the agent's computer — sign in for it when it asks",
  },
];

/** What the tile's key chip says. */
export function launcherKeyLabel(tile: Pick<LauncherTileCopy, "key">): string {
  return tile.key;
}

export interface LauncherContext {
  /** The chat computer's browser, by its name ("uno-product"); null — this chat has none. */
  readonly agentBrowserOn: string | null;
  /** A computer to browse files on. */
  readonly hasComputer: boolean;
  /** The chat on screen is a saved chat in a git project (its Changes panel). */
  readonly canOpenChanges: boolean;
}

export function visibleLauncherTiles(context: LauncherContext): LauncherTileCopy[] {
  return LAUNCHER_TILES.filter((tile) => {
    switch (tile.id) {
      case "site":
      case "apps":
        // Always: Your site is the default tool; Apps says how to get one.
        return true;
      case "agentBrowser":
        return context.agentBrowserOn !== null;
      case "files":
        return context.hasComputer;
      case "changes":
        return context.canOpenChanges;
    }
    return false;
  });
}

/** The tile a letter opens (no modifiers), or null. */
export function launcherTileForKey(
  tiles: ReadonlyArray<LauncherTileCopy>,
  event: {
    readonly key: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey?: boolean;
  },
): LauncherTileId | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (event.key.length !== 1) return null;
  const letter = event.key.toUpperCase();
  return tiles.find((tile) => tile.key === letter)?.id ?? null;
}

/**
 * Letters go to the launcher unless the person is typing somewhere (an input,
 * a textarea — the terminal's too — or rich text like the composer). Focus
 * on a button (Panel, just clicked) or nowhere is not typing.
 */
export function isTypingTarget(
  target: {
    readonly tagName?: string;
    readonly isContentEditable?: boolean;
  } | null,
): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

// ── Apps & sites list ────────────────────────────────────────────────────

/** One app in the launcher's list: on which computer, does it run, what a click opens. */
export interface LauncherAppRow {
  readonly key: string;
  readonly name: string;
  readonly icon: string | null;
  readonly iconImage: string | null;
  readonly templateId: string | null;
  readonly computer: string;
  readonly state: "running" | "asleep" | "stopped";
  /** What a click opens as a tab; null — nothing to open now (stopped, no address). */
  readonly url: string | null;
}

export const APP_STATE_LABEL: Record<LauncherAppRow["state"], string> = {
  running: "Running",
  asleep: "Asleep",
  stopped: "Stopped",
};

export function launcherAppState(status: ProgramStatus): LauncherAppRow["state"] {
  if (status === "running") return "running";
  if (status === "asleep") return "asleep";
  return "stopped";
}

/** Apps of every computer: the ones that open first, then by name; one row per app and computer. */
function launcherAppRank(row: LauncherAppRow): number {
  return row.url !== null ? 0 : row.state === "running" ? 1 : 2;
}

export function sortLauncherApps(rows: ReadonlyArray<LauncherAppRow>): LauncherAppRow[] {
  return rows.toSorted(
    (a, b) => launcherAppRank(a) - launcherAppRank(b) || a.name.localeCompare(b.name),
  );
}

/** What the empty Apps list suggests asking the agent (a click puts it into the chat's box). */
export const APP_IDEAS: ReadonlyArray<string> = [
  "Make me a dashboard of this week's sales",
  "Make a page that shows my AI limits",
  "Make a small app to track who owes what",
];

// ── The launcher of 0.0.137 (flag `panelLauncherV2` off) ──────────────────
//
// Big tiles — Browser, Files, Terminal, Changes, Apps, Sites — each opening
// the thing that already exists; a tile that would open nothing here is not
// shown (no tiles turned off, no "coming soon"). Kept word for word so the
// launcher without the flag is exactly the released one.

export type LegacyLauncherTileId = "browser" | "files" | "terminal" | "changes" | "apps" | "sites";

export interface LegacyLauncherTileCopy {
  readonly id: LegacyLauncherTileId;
  readonly name: string;
  /** One letter opens it while the launcher has focus (like t3's empty panel). */
  readonly key: string;
  readonly description: string;
}

/** Display order. */
export const LEGACY_LAUNCHER_TILES: ReadonlyArray<LegacyLauncherTileCopy> = [
  { id: "browser", name: "Browser", key: "B", description: "Open a website" },
  { id: "files", name: "Files", key: "F", description: "Browse the computer's files" },
  { id: "terminal", name: "Terminal", key: "T", description: "A command line in this project" },
  { id: "changes", name: "Changes", key: "C", description: "What changed in this project" },
  { id: "apps", name: "Apps", key: "A", description: "Apps on your computer" },
  { id: "sites", name: "Sites", key: "S", description: "Your sites on Uno" },
];

export interface LegacyLauncherContext {
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

export function visibleLegacyLauncherTiles(
  context: LegacyLauncherContext,
): LegacyLauncherTileCopy[] {
  const shown: Record<LegacyLauncherTileId, boolean> = {
    browser: context.canBrowse,
    files: context.hasComputer,
    terminal: context.canOpenTerminal,
    changes: context.canOpenChanges,
    // While the list loads the tile stays: it opens the list, which says so.
    apps: context.openableApps === null || context.openableApps > 0,
    sites: context.sites !== null && context.sites > 0,
  };
  return LEGACY_LAUNCHER_TILES.filter((tile) => shown[tile.id]);
}

/** The tile a plain letter opens (no modifiers; Shift doesn't matter), or null. */
export function legacyLauncherTileForKey(
  tiles: ReadonlyArray<LegacyLauncherTileCopy>,
  event: {
    readonly key: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
  },
): LegacyLauncherTileId | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.key.length !== 1) return null;
  const letter = event.key.toUpperCase();
  return tiles.find((tile) => tile.key === letter)?.id ?? null;
}
