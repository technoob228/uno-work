/**
 * The right panel's tab row (w0138, point 4; Misha 16.10): up to three
 * outlined groups, like tab groups in Chrome — **This chat → Project →
 * Everywhere**, left to right: the wider the group, the further right. An
 * empty group isn't drawn — except while a tab is dragged, as a slot to drop into. Moving to another chat of the same project keeps
 * Everywhere and Project as they are; only the chat's group changes. Pure
 * functions — PanelTabStrip renders them, unit tests check them.
 *
 * The groups are the existing levels of `previewTabScopes` (global / project
 * / chat) — nothing new is stored, saved tabs of older versions read as is.
 */

import type { PreviewTabScope } from "./previewTabScopes";
// Types only: PreviewPaneContext imports this module's neighbours by value.
import type { PreviewFile } from "./PreviewPaneContext";

/** Left to right. */
export const GROUP_ORDER: ReadonlyArray<PreviewTabScope> = ["chat", "project", "global"];

export interface TabGroup {
  readonly scope: PreviewTabScope;
  readonly files: ReadonlyArray<PreviewFile>;
}

/** Visible tabs as groups, This chat → Project → Everywhere; empty groups are left out. */
export function groupStripTabs(
  files: ReadonlyArray<PreviewFile>,
  tabScopeById: Readonly<Record<string, PreviewTabScope>>,
): ReadonlyArray<TabGroup> {
  return GROUP_ORDER.map((scope) => ({
    scope,
    files: files.filter((file) => (tabScopeById[file.id] ?? "chat") === scope),
  })).filter((group) => group.files.length > 0);
}

/**
 * Groups drawn while a tab is being dragged (Misha 16.10, point 3): all three,
 * This chat → Project → Everywhere — a missing one as an empty slot, so a tab
 * can be dropped into a group that has no tabs yet. Not dragging: as is.
 */
export function groupsForDrag(
  groups: ReadonlyArray<TabGroup>,
  dragging: boolean,
): ReadonlyArray<TabGroup> {
  if (!dragging) return groups;
  return GROUP_ORDER.map(
    (scope) => groups.find((group) => group.scope === scope) ?? { scope, files: [] },
  );
}

/**
 * Where a tab dragged over `overId` of a group lands: before it when the
 * pointer is on its left half, else before the next tab of the group (null —
 * at the group's end). Feeds `moveTabScope(…, scope, beforeId)`.
 */
export function dropBeforeId(
  groupFiles: ReadonlyArray<PreviewFile>,
  overId: string,
  leftHalf: boolean,
): string | null {
  const index = groupFiles.findIndex((file) => file.id === overId);
  if (index === -1) return null;
  if (leftHalf) return overId;
  return groupFiles[index + 1]?.id ?? null;
}

/**
 * Tabs a group shows: all of them; folded (its label clicked, like Chrome)
 * only the open one, if it is in this group — the same rule as a folded
 * project in the sidebar.
 */
export function tabsShownInGroup(
  files: ReadonlyArray<PreviewFile>,
  collapsed: boolean,
  activeId: string | null,
): ReadonlyArray<PreviewFile> {
  return collapsed ? files.filter((file) => file.id === activeId) : files;
}

/** Name of a group in the row and the menus. */
export const GROUP_LABEL: Record<PreviewTabScope, string> = {
  global: "Everywhere",
  project: "Project",
  chat: "This chat",
};

/** "Move to" choices of a tab's menu. */
export function moveToLabel(scope: PreviewTabScope, projectName: string | null): string {
  if (scope === "project") return projectName ? `Project · ${projectName}` : "Project";
  return GROUP_LABEL[scope];
}

/**
 * One line in a tab's tooltip, under its name: where it stays pinned (Misha
 * 16.10, point 5).
 */
export function scopeHint(scope: PreviewTabScope, projectName: string | null): string {
  switch (scope) {
    case "chat":
      return "Pinned while you're in this chat";
    case "project":
      return `Pinned while you're in ${projectName?.trim() || "this project"}`;
    case "global":
      return "Always pinned — in every chat and screen";
  }
}

/**
 * Widths, like Chrome: a tab shrinks from 180 to 72 px; when the row still
 * doesn't fit, inactive tabs fold into icons — the chat's group first, then
 * Project, then Everywhere, so the groups that stay across chats change last.
 * The active tab always keeps its name; past that the row scrolls with a fade.
 */
export const TAB_MAX_WIDTH = 180;
export const TAB_MIN_WIDTH = 72;
export const TAB_ICON_WIDTH = 28;
export const TAB_GAP = 2;
/** Outline padding of a group plus the gap after it. */
const GROUP_PADDING = 10;

/**
 * Width of a group's label: its icon or its name (about 6.5 px a letter at
 * 11 px), plus the count of tabs it hides when collapsed.
 */
export function groupLabelWidth(scope: PreviewTabScope, withIcons: boolean, hidden = 0): number {
  const base = withIcons ? 22 : Math.round(GROUP_LABEL[scope].length * 6.5) + 14;
  return hidden > 0 ? base + 6 + String(hidden).length * 7 : base;
}

const FOLD_ORDER: ReadonlyArray<ReadonlyArray<PreviewTabScope>> = [
  [],
  ["chat"],
  ["chat", "project"],
  ["chat", "project", "global"],
];

interface FitGroup {
  readonly scope: PreviewTabScope;
  /** Tabs it shows (a collapsed group: 0, or 1 — the open tab). */
  readonly count: number;
  /** The active tab is in this group. */
  readonly active: boolean;
  /** Its label, see groupLabelWidth. */
  readonly labelWidth: number;
}

function rowWidth(groups: ReadonlyArray<FitGroup>, folded: ReadonlyArray<PreviewTabScope>): number {
  let width = 0;
  for (const group of groups) {
    const fold = folded.includes(group.scope);
    const named = fold ? (group.active ? 1 : 0) : group.count;
    const icons = group.count - named;
    width +=
      GROUP_PADDING +
      group.labelWidth +
      named * TAB_MIN_WIDTH +
      icons * TAB_ICON_WIDTH +
      group.count * TAB_GAP;
  }
  return width;
}

/** Groups whose inactive tabs show as icons, so the row fits `available` px. */
export function foldedGroups(input: {
  readonly available: number;
  readonly groups: ReadonlyArray<FitGroup>;
}): ReadonlyArray<PreviewTabScope> {
  for (const folded of FOLD_ORDER) {
    if (rowWidth(input.groups, folded) <= input.available) return folded;
  }
  return FOLD_ORDER[FOLD_ORDER.length - 1]!;
}
