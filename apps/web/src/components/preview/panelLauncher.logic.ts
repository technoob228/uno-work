/**
 * The right panel's launcher (plan 22, step 1; w0138): big tiles when the
 * panel is open with nothing in it, and from "+" in the tab strip. Each tile
 * opens a thing that already exists. Pure, so the rules are tested directly.
 *
 *   - Browser          — the browser of this device (the desktop app's own,
 *                        right in the panel): you click, the agent sees, and
 *                        it has Comment and Debug.
 *   - Agent's browser  — the browser on the chat's computer (a cloud one):
 *                        the agent works there, you watch it live and can
 *                        take control.
 *   - Files, Changes   — as before.
 *   - Apps             — always: the person's apps on every computer and
 *                        their sites, with an empty state that says how to
 *                        get one.
 *
 * The terminal is not here: it opens at the bottom of the chat (Ctrl+`), and
 * a tile that opened something somewhere else confused people (16.10).
 */
import type { ProgramStatus } from "../computer/programModel";
import type { BrowserSource } from "./browserSource";

export type LauncherTileId = "browser" | "agentBrowser" | "files" | "changes" | "apps";

export interface LauncherTileCopy {
  readonly id: LauncherTileId;
  readonly name: string;
  /** One letter opens it while the launcher has focus (like t3's empty panel). */
  readonly key: string;
  readonly description: string;
  /** Where "Browser" opens by default (`browserOpenIn`); only when both browsers are here. */
  readonly isDefault?: boolean;
}

/** Display order; descriptions of the two browsers depend on where they run (see below). */
export const LAUNCHER_TILES: ReadonlyArray<LauncherTileCopy> = [
  { id: "browser", name: "Browser", key: "B", description: "Open a website" },
  {
    id: "agentBrowser",
    name: "Agent's browser",
    key: "W",
    description: "Watch the agent work live",
  },
  { id: "files", name: "Files", key: "F", description: "Browse the computer's files" },
  { id: "changes", name: "Changes", key: "C", description: "What changed in this project" },
  { id: "apps", name: "Apps", key: "A", description: "Your apps and sites" },
];

export interface LauncherContext {
  /** This device's browser in the panel: the desktop app's own (or the companion's tab on the web). */
  readonly canBrowseHere: boolean;
  /** It is the desktop app's own browser, with Comment and Debug. */
  readonly browserHasTools: boolean;
  /** "this Mac", "this computer" — where Browser runs. */
  readonly deviceName: string;
  /** The chat computer's browser, by its name ("uno-product"); null — this chat has none. */
  readonly agentBrowserOn: string | null;
  /** Where Browser / "+" open a page now (the person's default, else Uno's rule). */
  readonly defaultBrowser: BrowserSource;
  /** A computer to browse files on. */
  readonly hasComputer: boolean;
  /** The chat on screen is a saved chat in a git project (its Changes panel). */
  readonly canOpenChanges: boolean;
}

export function visibleLauncherTiles(context: LauncherContext): LauncherTileCopy[] {
  const both = context.canBrowseHere && context.agentBrowserOn !== null;
  const tiles: LauncherTileCopy[] = [];
  for (const tile of LAUNCHER_TILES) {
    switch (tile.id) {
      case "browser":
        if (!context.canBrowseHere) break;
        tiles.push({
          ...tile,
          description: context.browserHasTools
            ? `On ${context.deviceName}. You click, the agent sees. Comment and debug`
            : `On ${context.deviceName}. You click, the agent sees`,
          ...(both ? { isDefault: context.defaultBrowser === "app" } : {}),
        });
        break;
      case "agentBrowser":
        if (context.agentBrowserOn === null) break;
        tiles.push({
          ...tile,
          description: `On ${context.agentBrowserOn}. Watch the agent live, take control`,
          ...(both ? { isDefault: context.defaultBrowser === "computer" } : {}),
        });
        break;
      case "files":
        if (context.hasComputer) tiles.push(tile);
        break;
      case "changes":
        if (context.canOpenChanges) tiles.push(tile);
        break;
      case "apps":
        // Always: with no apps it says how to get one.
        tiles.push(tile);
        break;
    }
  }
  return tiles;
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
export function sortLauncherApps(rows: ReadonlyArray<LauncherAppRow>): LauncherAppRow[] {
  const rank = (row: LauncherAppRow) => (row.url !== null ? 0 : row.state === "running" ? 1 : 2);
  return rows.toSorted((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** What the empty Apps list suggests asking the agent (a click puts it into the chat's box). */
export const APP_IDEAS: ReadonlyArray<string> = [
  "Make me a dashboard of this week's sales",
  "Make a page that shows my AI limits",
  "Make a small app to track who owes what",
];
