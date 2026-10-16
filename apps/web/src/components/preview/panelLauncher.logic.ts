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

/** Display order: Your site is always first. */
export const LAUNCHER_TILES: ReadonlyArray<LauncherTileCopy> = [
  {
    id: "site",
    name: "Your site",
    key: "S",
    description: "Open your site or app — comment and debug right on the page",
  },
  {
    id: "agentBrowser",
    name: "Agent's browser",
    key: "B",
    description: "The browser on the agent's computer — sign in for it when it asks",
  },
  { id: "files", name: "Files", key: "F", description: "Browse the computer's files" },
  { id: "changes", name: "Changes", key: "C", description: "What the agent changed" },
  { id: "apps", name: "Apps", key: "A", description: "Your apps and sites" },
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
