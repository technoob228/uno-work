/**
 * The right panel's tab row and "All tabs" menu (w0138, point 4): which tabs
 * sit where, and what the menu lists. Pure functions — PanelTabStrip and
 * AllTabsMenu render them, unit tests check them.
 *
 * Two layouts of the same three levels (`previewTabScopes`):
 *
 * - `pins` (default) — like pinned tabs in a browser: on the left the tabs
 *   kept for longer than this chat, icon only (first "everywhere", then
 *   "project"); a thin divider; then the tabs of this chat with their names.
 *   Another chat of the same project keeps the pins, swaps the chat's tabs.
 * - `project` — like Codex: what the person opens belongs to the project and
 *   shows in every chat of it; each chat remembers which tab it had open.
 *   Only "everywhere" tabs are icon-only pins there.
 */

import { chatScopeKey, GLOBAL_SCOPE_KEY, projectScopeKey, scopeOfKey } from "./previewTabScopes";
import type { PreviewTabScope, PreviewTabTarget } from "./previewTabScopes";
// Types only: PreviewPaneContext imports this module's neighbours by value.
import type { PreviewFile } from "./PreviewPaneContext";

export type PanelTabsLayout = "pins" | "project";

export interface StripTabs {
  /** Icon-only pins on the left, in display order. */
  readonly pinned: ReadonlyArray<PreviewFile>;
  /** Named tabs after the divider. */
  readonly named: ReadonlyArray<PreviewFile>;
}

/** Split the visible tabs (already ordered global → project → chat) into pins and named tabs. */
export function splitStripTabs(
  files: ReadonlyArray<PreviewFile>,
  tabScopeById: Readonly<Record<string, PreviewTabScope>>,
  layout: PanelTabsLayout,
): StripTabs {
  const isPin = (file: PreviewFile) => {
    const scope = tabScopeById[file.id] ?? "chat";
    return layout === "pins" ? scope !== "chat" : scope === "global";
  };
  return { pinned: files.filter(isPin), named: files.filter((file) => !isPin(file)) };
}

/**
 * Where a tab goes when it is dropped on the other side of the divider: onto
 * the pins = kept for the project (an "everywhere" pin stays where it is);
 * onto the named tabs = back to this chat (in `project` layout — the project).
 */
export function scopeForDrop(
  zone: "pinned" | "named",
  current: PreviewTabScope,
  layout: PanelTabsLayout,
): PreviewTabScope | null {
  if (zone === "pinned") {
    if (layout === "project") return current === "global" ? null : "global";
    return current === "chat" ? "project" : null;
  }
  if (current === "chat") return null;
  if (layout === "project") return current === "global" ? "project" : null;
  return "chat";
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

/** Menu labels of a tab's level — the person's words, with the project's name. */
export function scopeChoiceLabel(
  scope: PreviewTabScope,
  projectName: string | null,
  layout: PanelTabsLayout,
): string {
  switch (scope) {
    case "chat":
      return layout === "project" ? "Only in this chat" : "Keep in this chat";
    case "project":
      return layout === "project"
        ? `In every chat of ${projectName ?? "the project"}`
        : `Pin to project ${projectName ?? ""}`.trim();
    case "global":
      return "Show in every chat";
  }
}

/** One line under a tab's name: where it lives. */
export function scopeHint(scope: PreviewTabScope, projectName: string | null): string {
  switch (scope) {
    case "chat":
      return "Open in this chat";
    case "project":
      return `Pinned to project ${projectName ?? ""}`.trim();
    case "global":
      return "Shown in every chat";
  }
}

/**
 * Widths of the named tabs, like Chrome: each tab shrinks from 180 to 72 px;
 * when even that doesn't fit, the inactive tabs fold into icons and only the
 * active one keeps its name (it is always fully in view). Past that the row
 * scrolls, with a fade on the side that has more.
 */
export const TAB_MAX_WIDTH = 180;
export const TAB_MIN_WIDTH = 72;
export const TAB_ICON_WIDTH = 28;
export const TAB_GAP = 4;

export type StripFit = "names" | "icons";

export function fitStripTabs(available: number, count: number): StripFit {
  if (count <= 1) return "names";
  return count * TAB_MIN_WIDTH + (count - 1) * TAB_GAP <= available ? "names" : "icons";
}

/** Short label of a pinned tab: the name without its extension ("README", "pricing"). */
export function pinLabel(file: Pick<PreviewFile, "name" | "kind">): string {
  if (file.kind === "app" || file.kind === "browser") return file.name;
  const dot = file.name.lastIndexOf(".");
  return dot > 0 ? file.name.slice(0, dot) : file.name;
}
