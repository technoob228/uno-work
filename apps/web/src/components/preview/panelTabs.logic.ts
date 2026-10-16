/**
 * The right panel's tab row and "All tabs" menu (w0138, point 4; Misha
 * 16.10): the row is up to three outlined groups, like tab groups in Chrome —
 * **Everywhere → Project → This chat**, left to right, widest to narrowest.
 * An empty group isn't drawn. Moving to another chat of the same project keeps
 * Everywhere and Project as they are; only the chat's group changes. Pure
 * functions — PanelTabStrip and AllTabsMenu render them, unit tests check them.
 *
 * The groups are the existing levels of `previewTabScopes` (global / project
 * / chat) — nothing new is stored, saved tabs of older versions read as is.
 */

import { chatScopeKey, GLOBAL_SCOPE_KEY, projectScopeKey, scopeOfKey } from "./previewTabScopes";
import type { PreviewTabScope, PreviewTabTarget } from "./previewTabScopes";
// Types only: PreviewPaneContext imports this module's neighbours by value.
import type { PreviewFile } from "./PreviewPaneContext";

export interface TabGroup {
  readonly scope: PreviewTabScope;
  readonly files: ReadonlyArray<PreviewFile>;
}

/** Visible tabs (already ordered global → project → chat) as groups; empty groups are left out. */
export function groupStripTabs(
  files: ReadonlyArray<PreviewFile>,
  tabScopeById: Readonly<Record<string, PreviewTabScope>>,
): ReadonlyArray<TabGroup> {
  return (["global", "project", "chat"] as const)
    .map((scope) => ({
      scope,
      files: files.filter((file) => (tabScopeById[file.id] ?? "chat") === scope),
    }))
    .filter((group) => group.files.length > 0);
}

/** What the "All tabs" menu needs to know about a chat to name it and go there. */
export interface PanelChatInfo {
  readonly title: string;
  readonly projectKey: string | null;
  readonly environmentId: string;
}

export interface OtherChatTab {
  readonly file: PreviewFile;
  readonly threadId: string;
  readonly chat: PanelChatInfo;
}

export interface AllTabsSections {
  readonly thisChat: ReadonlyArray<PreviewFile>;
  readonly project: ReadonlyArray<PreviewFile>;
  readonly everywhere: ReadonlyArray<PreviewFile>;
  /** Documents open in other chats (of this project, when in a chat). */
  readonly otherChats: ReadonlyArray<OtherChatTab>;
}

/** Same document = same file path, or the same page address. */
export function sameDocument(a: PreviewFile, b: PreviewFile): boolean {
  if (a.id === b.id) return true;
  if (a.path && b.path) return a.path === b.path;
  if (a.url && b.url) return a.url === b.url;
  return false;
}

function matches(query: string, ...texts: ReadonlyArray<string | null | undefined>): boolean {
  if (!query) return true;
  return texts.some((text) => text?.toLowerCase().includes(query));
}

/** Tasks tabs and empty "new tab" pages are about their own chat: not worth listing elsewhere. */
function listedElsewhere(file: PreviewFile): boolean {
  if (file.kind === "tasks") return false;
  if (file.kind === "browser" && !file.url) return false;
  return true;
}

/**
 * Sections of the "All tabs" menu. "In other chats" lists documents the
 * person had open in another chat — in a chat only chats of the same project
 * (that is what "switch and look at a document" means), outside a chat every
 * chat; a document already open here is not repeated.
 */
export function collectAllTabs(input: {
  readonly states: Readonly<Record<string, { readonly files: ReadonlyArray<PreviewFile> }>>;
  readonly target: PreviewTabTarget;
  readonly chatInfo: (threadId: string) => PanelChatInfo | null;
  readonly query?: string;
}): AllTabsSections {
  const query = (input.query ?? "").trim().toLowerCase();
  const { states, target } = input;
  const bucket = (key: string) => states[key]?.files ?? [];
  const filter = (files: ReadonlyArray<PreviewFile>) =>
    files.filter((file) => matches(query, file.name, file.path, file.url));

  const everywhereAll = bucket(GLOBAL_SCOPE_KEY);
  const projectAll = target.threadId ? bucket(projectScopeKey(target.projectKey)) : [];
  const thisChatAll = target.threadId ? bucket(chatScopeKey(target.threadId)) : [];
  const here = [...everywhereAll, ...projectAll, ...thisChatAll];

  const otherChats: OtherChatTab[] = [];
  const seen: PreviewFile[] = [];
  for (const [scopeKey, value] of Object.entries(states)) {
    if (scopeOfKey(scopeKey) !== "chat") continue;
    const threadId = scopeKey.slice("chat:".length);
    if (threadId === target.threadId) continue;
    const chat = input.chatInfo(threadId);
    if (!chat) continue;
    if (target.threadId && chat.projectKey !== target.projectKey) continue;
    for (const file of value.files) {
      if (!listedElsewhere(file)) continue;
      if (here.some((open) => sameDocument(open, file))) continue;
      if (seen.some((open) => sameDocument(open, file))) continue;
      if (!matches(query, file.name, file.path, file.url, chat.title)) continue;
      seen.push(file);
      otherChats.push({ file, threadId, chat });
    }
  }

  return {
    thisChat: filter(thisChatAll),
    project: filter(projectAll),
    everywhere: filter(everywhereAll),
    otherChats,
  };
}

/** Name of a group in the row, the menus and "All tabs". */
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

/** One line in a tab's tooltip: where it lives. */
export function scopeHint(scope: PreviewTabScope, projectName: string | null): string {
  switch (scope) {
    case "chat":
      return "Only in this chat";
    case "project":
      return `In every chat of ${projectName ?? "the project"}`;
    case "global":
      return "Everywhere — in every chat and screen";
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
/** Outline padding of a group, plus its icon when groups carry one, plus the gap after it. */
export const GROUP_CHROME = { icon: 30, plain: 10 } as const;

const FOLD_ORDER: ReadonlyArray<ReadonlyArray<PreviewTabScope>> = [
  [],
  ["chat"],
  ["chat", "project"],
  ["chat", "project", "global"],
];

function rowWidth(
  groups: ReadonlyArray<{ readonly scope: PreviewTabScope; readonly count: number; readonly active: boolean }>,
  folded: ReadonlyArray<PreviewTabScope>,
  chrome: number,
): number {
  let width = 0;
  for (const group of groups) {
    const fold = folded.includes(group.scope);
    const named = fold ? (group.active ? 1 : 0) : group.count;
    const icons = group.count - named;
    width += chrome + named * TAB_MIN_WIDTH + icons * TAB_ICON_WIDTH + (group.count - 1) * TAB_GAP;
  }
  return width;
}

/** Groups whose inactive tabs show as icons, so the row fits `available` px. */
export function foldedGroups(input: {
  readonly available: number;
  readonly groups: ReadonlyArray<{
    readonly scope: PreviewTabScope;
    readonly count: number;
    /** The active tab is in this group. */
    readonly active: boolean;
  }>;
  readonly withIcons: boolean;
}): ReadonlyArray<PreviewTabScope> {
  const chrome = input.withIcons ? GROUP_CHROME.icon : GROUP_CHROME.plain;
  for (const folded of FOLD_ORDER) {
    if (rowWidth(input.groups, folded, chrome) <= input.available) return folded;
  }
  return FOLD_ORDER[FOLD_ORDER.length - 1]!;
}
