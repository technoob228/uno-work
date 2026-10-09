import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HoverPanelController } from "./sidebarD.hover";
import {
  accountMenuLines,
  dRowMark,
  foldedProjectMark,
  groupChatsForSidebarD,
  isHomePath,
  isRunningStatus,
  needsYouPlace,
  parseFoldedProjects,
  sidebarDRailShown,
  unoRunningLabel,
} from "./sidebarD.logic";

interface Chat {
  readonly id: string;
  readonly fromUno?: boolean;
  readonly running?: boolean;
  readonly project?: string;
  readonly at: number;
}

const group = (chats: Chat[]) =>
  groupChatsForSidebarD({
    chats,
    isFromUno: (chat) => chat.fromUno === true,
    isRunning: (chat) => chat.running === true,
    projectOf: (chat) => (chat.project ? { key: chat.project, name: chat.project } : null),
    activityMs: (chat) => chat.at,
  });

describe("sidebar D: chats into Uno / Projects / Recents", () => {
  it("keeps Uno's running chats under Uno and sends finished ones to their project", () => {
    const groups = group([
      { id: "a", fromUno: true, running: true, project: "bakery-site", at: 5 },
      { id: "b", fromUno: true, running: false, project: "orders-bot", at: 4 },
      { id: "c", project: "bakery-site", at: 3 },
      { id: "d", at: 2 },
      { id: "e", fromUno: true, running: true, at: 1 },
    ]);
    expect(groups.unoRunning.map((chat) => chat.id)).toEqual(["a", "e"]);
    expect(groups.projects.map((project) => [project.key, project.chats.map((c) => c.id)])).toEqual(
      [
        ["orders-bot", ["b"]],
        ["bakery-site", ["c"]],
      ],
    );
    expect(groups.recents.map((chat) => chat.id)).toEqual(["d"]);
  });

  it("orders projects by their newest chat and keeps chat order inside", () => {
    const groups = group([
      { id: "old-1", project: "p1", at: 1 },
      { id: "new-2", project: "p2", at: 9 },
      { id: "old-2", project: "p2", at: 2 },
      { id: "mid-1", project: "p1", at: 5 },
    ]);
    expect(groups.projects.map((project) => project.key)).toEqual(["p2", "p1"]);
    expect(groups.projects[1]?.chats.map((c) => c.id)).toEqual(["old-1", "mid-1"]);
  });

  it("reads running as working or waiting on the person", () => {
    expect(isRunningStatus("working")).toBe(true);
    expect(isRunningStatus("approval")).toBe(true);
    expect(isRunningStatus("input")).toBe(true);
    expect(isRunningStatus("ready")).toBe(false);
    expect(isRunningStatus("failed")).toBe(false);
    expect(unoRunningLabel(3)).toBe("3 running");
    expect(unoRunningLabel(0)).toBeNull();
  });
});

describe("sidebar D: marks", () => {
  it("shows Your turn only for a finished chat that waits on the person", () => {
    expect(dRowMark("ready", true)).toBe("your-turn");
    expect(dRowMark("ready", false)).toBeNull();
    expect(dRowMark("working", true)).toBe("working");
    expect(dRowMark("approval", false)).toBe("approval");
  });

  it("a folded project shows the most urgent dot: needs you › error › working", () => {
    expect(foldedProjectMark(["working", "failed", null])).toBe("failed");
    expect(foldedProjectMark(["working", "failed", "your-turn"])).toBe("your-turn");
    expect(foldedProjectMark(["working", null])).toBe("working");
    expect(foldedProjectMark([null, null])).toBeNull();
  });
});

describe("sidebar D: rail and memory", () => {
  it("shows the rail by choice or in a narrow window, never on a phone", () => {
    const base = {
      collapsedChoice: false,
      narrow: false,
      openedWhileNarrow: false,
      isMobile: false,
    };
    expect(sidebarDRailShown(base)).toBe(false);
    expect(sidebarDRailShown({ ...base, collapsedChoice: true })).toBe(true);
    expect(sidebarDRailShown({ ...base, narrow: true })).toBe(true);
    expect(sidebarDRailShown({ ...base, narrow: true, openedWhileNarrow: true })).toBe(false);
    expect(sidebarDRailShown({ ...base, collapsedChoice: true, isMobile: true })).toBe(false);
  });

  it("reads the folded projects back, ignoring junk", () => {
    expect([...parseFoldedProjects('["a","b",3]')]).toEqual(["a", "b"]);
    expect(parseFoldedProjects("{oops").size).toBe(0);
    expect(parseFoldedProjects(null).size).toBe(0);
  });
});

describe("sidebar D: the slide-out chats panel", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens ~0.15 s after pointing at Uno or Chats, not on a quick pass", () => {
    const seen: boolean[] = [];
    const panel = new HoverPanelController((open) => seen.push(open));
    panel.enterTrigger();
    vi.advanceTimersByTime(100);
    panel.leave();
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([]);
    panel.enterTrigger();
    vi.advanceTimersByTime(150);
    expect(seen).toEqual([true]);
  });

  it("stays while the pointer moves onto the panel and hides 0.3 s after it leaves", () => {
    const seen: boolean[] = [];
    const panel = new HoverPanelController((open) => seen.push(open));
    panel.openNow();
    panel.leave();
    vi.advanceTimersByTime(200);
    panel.enterPanel();
    vi.advanceTimersByTime(1000);
    expect(panel.open).toBe(true);
    panel.leave();
    vi.advanceTimersByTime(299);
    expect(panel.open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([true, false]);
  });

  it("hides at once on a click into the page or Esc", () => {
    const panel = new HoverPanelController(() => undefined);
    panel.openNow();
    panel.closeNow();
    expect(panel.open).toBe(false);
    panel.enterTrigger();
    panel.closeNow();
    vi.advanceTimersByTime(500);
    expect(panel.open).toBe(false);
  });
});

describe("accountMenuLines", () => {
  it("says where to sign in when this address can't reach the account", () => {
    expect(accountMenuLines("none", false)).toEqual({
      accountItems: false,
      signInElsewhere: true,
      desktopSignOut: false,
    });
  });

  it("offers Sign out of Uno only in the desktop app, once signed in", () => {
    expect(accountMenuLines("desktop", true).desktopSignOut).toBe(true);
    expect(accountMenuLines("desktop", false).desktopSignOut).toBe(false);
    expect(accountMenuLines("work-proxy", true)).toEqual({
      accountItems: true,
      signInElsewhere: false,
      desktopSignOut: false,
    });
  });
});

describe("Home in sidebar D (Misha 08.10: no way back to Home)", () => {
  it("lights Home on the start screen only", () => {
    expect(isHomePath("/computer")).toBe(true);
    expect(isHomePath("/files")).toBe(false);
    expect(isHomePath("/env-1/thread-1")).toBe(false);
    expect(isHomePath("/computer/x")).toBe(false);
  });
});

describe('needsYouPlace (Misha 08.10: no "Needs you 0")', () => {
  it("hides the row when nothing waits for the person, even with unread news", () => {
    expect(needsYouPlace(0)).toEqual({ shown: false, count: 0 });
  });

  it("shows the row with the number of approvals and questions waiting", () => {
    expect(needsYouPlace(3)).toEqual({ shown: true, count: 3 });
  });

  it("never shows a zero or a junk count", () => {
    expect(needsYouPlace(-1).shown).toBe(false);
    expect(needsYouPlace(Number.NaN).shown).toBe(false);
  });
});
