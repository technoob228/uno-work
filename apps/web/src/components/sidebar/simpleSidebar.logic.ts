/**
 * The simple sidebar (01.10), as data: which chat actions a person sees by
 * default, and how the history shelf is called. Everything else stays one
 * switch away — Settings → Developer → Dev mode.
 */
import type { ContextMenuItem } from "@t3tools/contracts";

/**
 * The chat menu without Dev mode: what a person does with a chat — rename,
 * pin, Read / Snooze / Done (the same three as on the row's hover, Misha
 * 13.10), archive, delete — plus the rare "Don't let agents write here"
 * (0.0.115): it has to be findable by the person who needs it, and it is
 * absent on older daemons.
 */
export const SIMPLE_THREAD_MENU_IDS = [
  "rename",
  "regenerate-title",
  "filter-by-project",
  "turn-into-project",
  "pin",
  "settle",
  "unsettle",
  "snooze",
  "unsnooze",
  "mark-read",
  "agents-access",
  "archive",
  "delete",
] as const;

/**
 * The right-click menu of a chat. Without Dev mode Rename, Regenerate title, Filter by, Pin, Done, Snooze,
 * Mark as read, "Don't let agents write here", Archive and Delete; with it,
 * everything (mark unread, copy path / id, continue on another machine).
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
export function doneShelfLabel(count: number, expanded: boolean, hasSnoozed = false): string {
  const name = hasSnoozed ? "Done and snoozed" : "Done";
  return expanded ? name : `${name} (${count})`;
}
