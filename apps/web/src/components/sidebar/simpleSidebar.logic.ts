/**
 * The simple sidebar (01.10), as data: which chat actions a person sees by
 * default, and how the history shelf is called. Everything else stays one
 * switch away — Settings → Developer → Dev mode.
 */
import type { ContextMenuItem } from "@t3tools/contracts";

import { SIDEBAR_MODES, type SidebarMode } from "../../navigation/navStore";

/** The four places of the sidebar (SidebarPrimaryNav). */
export type PrimaryNavItem = "chats" | "assistants" | "files" | "apps";

/** Which row is lit: a screen of its own wins, else what the sidebar lists. */
export function activePrimaryNavItem(input: {
  readonly pathname: string;
  readonly mode: SidebarMode;
}): PrimaryNavItem {
  if (input.pathname === "/assistants" || input.pathname.startsWith("/assistants/")) {
    return "assistants";
  }
  const mode = SIDEBAR_MODES.includes(input.mode) ? input.mode : "chats";
  return mode === "files" ? "files" : mode === "apps" ? "apps" : "chats";
}

/** The chat menu without Dev mode: four things a person does with a chat. */
export const SIMPLE_THREAD_MENU_IDS = ["rename", "pin", "archive", "delete"] as const;

/**
 * The right-click menu of a chat. Without Dev mode only Rename, Pin, Archive
 * and Delete; with it, everything (settle, snooze, mark unread, copy path / id,
 * continue on another machine).
 */
export function threadContextMenuItems<T extends ContextMenuItem<string>>(
  all: ReadonlyArray<T>,
  devMode: boolean,
): T[] {
  if (devMode) return [...all];
  const simple = new Set<string>(SIMPLE_THREAD_MENU_IDS);
  return all.filter((item) => simple.has(item.id));
}

/** The one history shelf without Dev mode: settled and snoozed chats together. */
export function doneShelfLabel(count: number, expanded: boolean): string {
  return expanded ? "Done" : `Done (${count})`;
}
