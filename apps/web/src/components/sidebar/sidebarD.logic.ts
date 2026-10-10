/**
 * Sidebar D (Misha 02.10–03.10, prototype reports/day_2026-10-02/sidebar/),
 * the pure parts: how the chats fold into Uno / Projects / Recents, which dot
 * a folded project shows, what is remembered per device, and the timing of
 * the collapsed rail's slide-out panel.
 *
 * Layout, top to bottom: the account + computer header (menu: Settings,
 * Plan & AI, Billing, Uno console, Help, Sign out; Search ⌘K and New chat as
 * icons), the places Home, Files and Apps & sites, "Needs you" only when
 * something waits for the person, then the chats: Uno pinned first (the chats it started and is
 * watching under it, "N running"), Projects as groups that fold, Recents
 * (chats in the home folder), and the Done shelf.
 */
import type { SidebarThreadStatus } from "../Sidebar.logic";

/** Expanded or collapsed: a choice of this device (laptop rail, big monitor full). */
export const SIDEBAR_D_COLLAPSED_KEY = "uno-work:sidebar:collapsed";
/** Project groups the person folded, by project key. */
export const SIDEBAR_D_FOLDED_PROJECTS_KEY = "uno-work:sidebar:folded-projects";
/** Uno's running chats folded away under its row. */
export const SIDEBAR_D_UNO_FOLDED_KEY = "uno-work:sidebar:uno-folded";
/** Narrower than this, Work shows the rail without changing the person's choice. */
export const SIDEBAR_D_NARROW_PX = 1000;
/** Pointing at Uno or Chats on the rail opens the chats panel after this long. */
export const SIDEBAR_D_PANEL_OPEN_DELAY_MS = 150;
/** The panel hides this long after the pointer leaves it (and the rail). */
export const SIDEBAR_D_PANEL_CLOSE_DELAY_MS = 300;

/** The one mark a D row shows at its end. */
export type DRowMark = "approval" | "input" | "your-turn" | "failed" | "working" | null;

export function dRowMark(status: SidebarThreadStatus, yourTurn: boolean): DRowMark {
  switch (status) {
    case "approval":
    case "input":
    case "failed":
    case "working":
      return status;
    case "ready":
      return yourTurn ? "your-turn" : null;
  }
}

/** A chat that is still going: Uno keeps it under its row until it finishes. */
export function isRunningStatus(status: SidebarThreadStatus): boolean {
  return status === "working" || status === "approval" || status === "input";
}

const MARK_RANK: Readonly<Record<Exclude<DRowMark, null>, number>> = {
  approval: 0,
  input: 0,
  "your-turn": 0,
  failed: 1,
  working: 2,
};

/** A folded project shows its most urgent chat: needs you › error › working. */
export function foldedProjectMark(marks: ReadonlyArray<DRowMark>): DRowMark {
  let best: DRowMark = null;
  for (const mark of marks) {
    if (mark === null) continue;
    if (best === null || MARK_RANK[mark] < MARK_RANK[best]) best = mark;
  }
  return best;
}

export interface DProjectGroup<T> {
  readonly key: string;
  readonly name: string;
  readonly chats: ReadonlyArray<T>;
}

export interface DChatGroups<T> {
  /** Chats Uno started and still runs — under the Uno row. */
  readonly unoRunning: ReadonlyArray<T>;
  /** Projects with live chats, the one worked in last first. */
  readonly projects: ReadonlyArray<DProjectGroup<T>>;
  /** Chats in the home folder (no project). */
  readonly recents: ReadonlyArray<T>;
}

/**
 * Fold the live chats (pinned and Done stay where they are) into Uno /
 * Projects / Recents. Chats keep their incoming order inside a group; a
 * project's place is its newest chat.
 */
export function groupChatsForSidebarD<T>(input: {
  readonly chats: ReadonlyArray<T>;
  /** Started by Uno (its own create_thread, or its agent's spawn). */
  readonly isFromUno: (chat: T) => boolean;
  readonly isRunning: (chat: T) => boolean;
  /** The chat's project, or null for the home folder / no project. */
  readonly projectOf: (chat: T) => { readonly key: string; readonly name: string } | null;
  readonly activityMs: (chat: T) => number;
}): DChatGroups<T> {
  const unoRunning: T[] = [];
  const recents: T[] = [];
  const byProject = new Map<string, { name: string; chats: T[]; latestMs: number }>();
  for (const chat of input.chats) {
    if (input.isFromUno(chat) && input.isRunning(chat)) {
      unoRunning.push(chat);
      continue;
    }
    const project = input.projectOf(chat);
    if (project === null) {
      recents.push(chat);
      continue;
    }
    const activity = input.activityMs(chat);
    const group = byProject.get(project.key);
    if (group) {
      group.chats.push(chat);
      if (activity > group.latestMs) group.latestMs = activity;
    } else {
      byProject.set(project.key, { name: project.name, chats: [chat], latestMs: activity });
    }
  }
  const projects = [...byProject.entries()]
    .toSorted(([, a], [, b]) => b.latestMs - a.latestMs)
    .map(([key, group]) => ({ key, name: group.name, chats: group.chats }));
  return { unoRunning, projects, recents };
}

/** "3 running", or nothing. */
export function unoRunningLabel(count: number): string | null {
  return count > 0 ? `${count} running` : null;
}

/** The rail shows when the person chose it, or the window is narrow; never on a phone. */
export function sidebarDRailShown(input: {
  readonly collapsedChoice: boolean;
  readonly narrow: boolean;
  /** Opened by hand in a narrow window (⌘B / expand), for this session only. */
  readonly openedWhileNarrow: boolean;
  readonly isMobile: boolean;
}): boolean {
  if (input.isMobile) return false;
  if (input.collapsedChoice) return true;
  return input.narrow && !input.openedWhileNarrow;
}

/** Parse the folded-projects record kept in localStorage; junk reads as none. */
export function parseFoldedProjects(raw: string | null): ReadonlySet<string> {
  if (!raw) return new Set();
  try {
    const value: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [],
    );
  } catch {
    return new Set();
  }
}

/**
 * The account lines of the account menu, by how this window reaches the Uno
 * account (`accountTransport()`):
 * - "none" (the computer's direct address, self-host, localhost, an own
 *   domain): the account items can't work here — say so with one explicit
 *   "Sign in at app.uno4.work" instead of silently leaving them out (WG-27);
 * - "desktop" and signed in: "Sign out of Uno" (the app keeps the token in
 *   the OS keychain; there was no way to drop it — WG-14).
 */
export function accountMenuLines(
  transport: "work-proxy" | "desktop" | "none",
  signedIn: boolean,
): {
  readonly accountItems: boolean;
  readonly signInElsewhere: boolean;
  readonly desktopSignOut: boolean;
} {
  return {
    accountItems: transport !== "none",
    signInElsewhere: transport === "none",
    desktopSignOut: transport === "desktop" && signedIn,
  };
}

/** Home is the computer's start screen (`/computer`): the Home row lights there. */
export const SIDEBAR_D_HOME_PATH = "/computer";

export function isHomePath(pathname: string): boolean {
  return pathname === SIDEBAR_D_HOME_PATH;
}

/**
 * "Inbox" in the sidebar (ICP v3, 09.10): always there — the agent says "sent
 * to your Inbox", and a finished task must be findable. The number shows only
 * when something is unread (Misha 08.10: no "0"), and "N need you" only when
 * an approval or a question really waits.
 */
const countOf = (value: number) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

export function inboxPlace(
  unread: number,
  needsYou: number,
): { readonly unread: number; readonly needsYou: number } {
  const waiting = countOf(needsYou);
  return { unread: Math.max(countOf(unread), waiting), needsYou: waiting };
}
