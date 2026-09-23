import type { InboxSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { freshItems } from "../inbox/InboxListener";
import { mergeInbox } from "../inbox/inboxStore";
import { joinAppPath } from "../inbox/useOpenInboxItem";
import { closeTab, tabForLocation, upsertTab, type DesktopTab } from "./desktopTabs";
import { effectiveNavLayout } from "./navStore";

const loc = (pathname: string, search: Record<string, unknown> = {}) => ({
  pathname,
  search,
  href: `${pathname}?${new URLSearchParams(search as Record<string, string>).toString()}`,
});

describe("layouts", () => {
  it("falls back to the standard sidebar without Labs, on phones, and tabs outside the desktop app", () => {
    const base = { labsEnabled: true, isMobile: false, isDesktopApp: true } as const;
    expect(effectiveNavLayout({ ...base, chosen: "rail" })).toBe("rail");
    expect(effectiveNavLayout({ ...base, chosen: "rail", labsEnabled: false })).toBe("sidebar");
    expect(effectiveNavLayout({ ...base, chosen: "rail", isMobile: true })).toBe("sidebar");
    expect(effectiveNavLayout({ ...base, chosen: "tabs" })).toBe("tabs");
    expect(effectiveNavLayout({ ...base, chosen: "tabs", isDesktopApp: false })).toBe("sidebar");
  });
});

describe("desktop tabs", () => {
  it("gives chats, apps and files a tab; Home and Settings none", () => {
    expect(tabForLocation(loc("/env1/thread1"))).toMatchObject({
      key: "thread:env1:thread1",
      kind: "thread",
      threadId: "thread1",
    });
    expect(tabForLocation(loc("/app", { url: "https://n.app", name: "Notes" }))).toMatchObject({
      key: "app:https://n.app",
      title: "Notes",
    });
    expect(tabForLocation(loc("/office", { path: "/h/Documents/report.docx" }))).toMatchObject({
      key: "file:/h/Documents/report.docx",
      title: "report.docx",
    });
    expect(tabForLocation(loc("/computer"))).toBeNull();
    expect(tabForLocation(loc("/settings/general"))).toBeNull();
  });

  it("opens a new tab right after the one you came from, and closing picks a neighbour", () => {
    const a = tabForLocation(loc("/e/a")) as DesktopTab;
    const b = tabForLocation(loc("/e/b")) as DesktopTab;
    const c = tabForLocation(loc("/e/c")) as DesktopTab;
    let tabs = upsertTab([], a, null);
    tabs = upsertTab(tabs, b, a.key);
    tabs = upsertTab(tabs, c, a.key);
    expect(tabs.map((tab) => tab.key)).toEqual([a.key, c.key, b.key]);
    expect(upsertTab(tabs, a, c.key)).toHaveLength(3);
    const closed = closeTab(tabs, c.key);
    expect(closed.tabs.map((tab) => tab.key)).toEqual([a.key, b.key]);
    expect(closed.neighbour?.key).toBe(b.key);
  });
});

describe("inbox in the window", () => {
  const snapshot = (items: Array<{ id: string; updatedAt: string; readAt?: string }>) =>
    ({
      unread: 0,
      items: items.map((item) => ({
        id: item.id,
        kind: "app",
        source: { kind: "app", id: "office", name: "Office", icon: null },
        title: item.id,
        body: null,
        open: null,
        createdAt: item.updatedAt,
        updatedAt: item.updatedAt,
        count: 1,
        readAt: item.readAt ?? null,
        snoozedUntil: null,
      })),
    }) as InboxSnapshot;

  it("notifies only about new or updated unread items, never on the first snapshot", () => {
    const first = snapshot([{ id: "a", updatedAt: "2026-09-24T10:00:00Z" }]);
    expect(freshItems(undefined, first)).toEqual([]);
    const next = snapshot([
      { id: "b", updatedAt: "2026-09-24T10:05:00Z" },
      { id: "a", updatedAt: "2026-09-24T10:00:00Z" },
      { id: "c", updatedAt: "2026-09-24T10:06:00Z", readAt: "2026-09-24T10:06:00Z" },
    ]);
    expect(freshItems(first, next).map((item) => item.id)).toEqual(["b"]);
  });

  it("merges computers newest first", () => {
    const merged = mergeInbox({
      e1: snapshot([{ id: "old", updatedAt: "2026-09-24T09:00:00Z" }]),
      e2: snapshot([{ id: "new", updatedAt: "2026-09-24T11:00:00Z" }]),
    });
    expect(merged.map((item) => [item.environmentId, item.id])).toEqual([
      ["e2", "new"],
      ["e1", "old"],
    ]);
  });

  it("opens an app at its own path", () => {
    expect(joinAppPath("https://notes-box.app.uno4.dev/", "/notes/42?x=1")).toBe(
      "https://notes-box.app.uno4.dev/notes/42?x=1",
    );
    expect(joinAppPath("https://n.dev/app/", null)).toBe("https://n.dev/app/");
  });
});
