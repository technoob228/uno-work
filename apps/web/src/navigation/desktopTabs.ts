/**
 * Layout "Desktop tabs" (desktop app, Labs): every chat, app and file you
 * open becomes a tab on top, like browser tabs; Home is always the first.
 * The tabs are a record of places (router locations), not live windows:
 * switching a tab navigates there, so every screen keeps behaving exactly as
 * in the standard layout. Remembered per device.
 */
import type { ParsedLocation } from "@tanstack/react-router";
import { create } from "zustand";

export type DesktopTabKind = "thread" | "app" | "file" | "files";

export interface DesktopTab {
  /** Stable per place: `thread:<env>:<id>`, `app:<url>`, `file:<path>`, `files`. */
  readonly key: string;
  readonly kind: DesktopTabKind;
  /** Where the tab leads (path + search). */
  readonly href: string;
  /** Known at open time; chats resolve their live title when drawn. */
  readonly title: string;
  readonly icon: string | null;
  readonly environmentId: string | null;
  readonly threadId: string | null;
}

export const DESKTOP_TABS_MAX = 12;
const STORAGE_KEY = "uno:desktop-tabs";

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);

type LocationLike = Pick<ParsedLocation, "pathname" | "href"> & {
  readonly search: unknown;
};

/** The tab a location belongs to; null = a place without a tab (Home, Settings, …). */
export function tabForLocation(location: LocationLike): DesktopTab | null {
  const search = (location.search ?? {}) as Record<string, unknown>;
  const segments = location.pathname.split("/").filter(Boolean);
  if (location.pathname === "/app") {
    const url = text(search["url"]);
    if (!url) return null;
    return {
      key: `app:${url}`,
      kind: "app",
      href: location.href,
      title: text(search["name"]) ?? url,
      icon: text(search["icon"]),
      environmentId: null,
      threadId: null,
    };
  }
  if (location.pathname === "/office") {
    const path = text(search["path"]) ?? text(search["key"]);
    if (!path) return null;
    return {
      key: `file:${path}`,
      kind: "file",
      href: location.href,
      title: basename(path),
      icon: null,
      environmentId: null,
      threadId: null,
    };
  }
  if (location.pathname === "/files") {
    const file = text(search["file"]);
    if (file) {
      return {
        key: `file:${file}`,
        kind: "file",
        href: location.href,
        title: basename(file),
        icon: null,
        environmentId: null,
        threadId: null,
      };
    }
    return {
      key: "files",
      kind: "files",
      href: location.href,
      title: "Files",
      icon: null,
      environmentId: null,
      threadId: null,
    };
  }
  if (location.pathname === "/drive") {
    return {
      key: "drive",
      kind: "files",
      href: location.href,
      title: "Uno Drive",
      icon: null,
      environmentId: null,
      threadId: null,
    };
  }
  // /<environmentId>/<threadId> — a chat.
  const [environmentId, threadId] = segments;
  if (
    segments.length === 2 &&
    environmentId &&
    threadId &&
    ![
      "settings",
      "assistant",
      "draft",
      "computer",
      "my-uno",
      "files",
      "drive",
      "office",
      "app",
    ].includes(environmentId)
  ) {
    return {
      key: `thread:${environmentId}:${threadId}`,
      kind: "thread",
      href: location.href,
      title: "Chat",
      icon: null,
      environmentId: decodeURIComponent(environmentId),
      threadId: decodeURIComponent(threadId),
    };
  }
  return null;
}

/** Open (or refresh) the tab of a place; a new tab goes right after `afterKey`. */
export function upsertTab(
  tabs: ReadonlyArray<DesktopTab>,
  tab: DesktopTab,
  afterKey: string | null,
): DesktopTab[] {
  const index = tabs.findIndex((entry) => entry.key === tab.key);
  if (index >= 0) {
    // Same place, maybe another sub-path (an app's page): remember where.
    return tabs.map((entry, at) =>
      at === index
        ? { ...entry, href: tab.href, title: tab.title, icon: tab.icon ?? entry.icon }
        : entry,
    );
  }
  const after = afterKey === null ? -1 : tabs.findIndex((entry) => entry.key === afterKey);
  const next = [...tabs];
  next.splice(after >= 0 ? after + 1 : next.length, 0, tab);
  // Too many: the oldest tabs furthest from the new one go first.
  while (next.length > DESKTOP_TABS_MAX) {
    const at = next.indexOf(tab);
    next.splice(at > next.length / 2 ? 0 : next.length - 1, 1);
  }
  return next;
}

/** Close a tab; returns the tab to show next when the closed one was active. */
export function closeTab(
  tabs: ReadonlyArray<DesktopTab>,
  key: string,
): { readonly tabs: DesktopTab[]; readonly neighbour: DesktopTab | null } {
  const index = tabs.findIndex((entry) => entry.key === key);
  if (index < 0) return { tabs: [...tabs], neighbour: null };
  const next = tabs.filter((entry) => entry.key !== key);
  return { tabs: next, neighbour: next[index] ?? next[index - 1] ?? null };
}

function readTabs(): DesktopTab[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(raw)
      ? raw.filter(
          (entry): entry is DesktopTab =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as DesktopTab).key === "string" &&
            typeof (entry as DesktopTab).href === "string",
        )
      : [];
  } catch {
    return [];
  }
}

interface DesktopTabsState {
  readonly tabs: ReadonlyArray<DesktopTab>;
  readonly setTabs: (tabs: ReadonlyArray<DesktopTab>) => void;
}

export const useDesktopTabsStore = create<DesktopTabsState>((set) => ({
  tabs: typeof window === "undefined" ? [] : readTabs(),
  setTabs: (tabs) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
    } catch {
      // private mode
    }
    set({ tabs });
  },
}));
