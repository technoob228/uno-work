/**
 * The pure parts of Home: which chats to put under "Continue", which ones wait
 * for the person, the greeting, and the widget layout (what's on Home, in
 * which order) with the reducer the Customize mode drives.
 */
import { isAssistantProjectId } from "@t3tools/contracts";

import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../../Sidebar.logic";
import type { SidebarThreadSummary } from "../../../types";

// ------------------------------------------------------------------ chats --

export type HomeThread = SidebarThreadSummary & { readonly lastVisitedAt?: string | undefined };

/** When the chat last moved: its own update time, else its last turn, else creation. */
export function threadActivityAt(thread: SidebarThreadSummary): number {
  const candidates = [
    thread.updatedAt,
    thread.latestTurn?.completedAt ?? null,
    thread.latestUserMessageAt,
    thread.createdAt,
  ];
  for (const value of candidates) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

/** Chats Home may show at all: not archived, not a Helper chat, not snoozed right now. */
export function isHomeVisibleThread(thread: SidebarThreadSummary, now: number): boolean {
  if (thread.archivedAt !== null) return false;
  if (isAssistantProjectId(thread.projectId)) return false;
  if (thread.snoozedUntil) {
    const until = Date.parse(thread.snoozedUntil);
    if (Number.isFinite(until) && until > now) return false;
  }
  return true;
}

export interface HomeThreadStatus {
  readonly kind: "approval" | "input" | "working" | "failed" | "done";
  readonly label: string;
  readonly colorClass: string;
  readonly dotClass: string;
  readonly pulse: boolean;
}

/**
 * The chat's status the way the sidebar reads it (same states, same hues:
 * amber approval, indigo input, sky working, red failed, emerald for a
 * result not seen yet), in Home's words. Null for a quiet, seen chat.
 */
export function homeThreadStatus(thread: HomeThread): HomeThreadStatus | null {
  switch (resolveSidebarThreadStatus(thread)) {
    case "approval":
      return {
        kind: "approval",
        label: "Needs approval",
        colorClass: "text-amber-600 dark:text-amber-300/90",
        dotClass: "bg-amber-500 dark:bg-amber-300/90",
        pulse: false,
      };
    case "input":
      return {
        kind: "input",
        label: "Asks you",
        colorClass: "text-indigo-600 dark:text-indigo-300/90",
        dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
        pulse: false,
      };
    case "working":
      return {
        kind: "working",
        label: "Working",
        colorClass: "text-sky-600 dark:text-sky-300/80",
        dotClass: "bg-sky-500 dark:bg-sky-300/80",
        pulse: true,
      };
    case "failed":
      return {
        kind: "failed",
        label: "Failed",
        colorClass: "text-red-600 dark:text-red-300",
        dotClass: "bg-red-500 dark:bg-red-300",
        pulse: false,
      };
    case "ready":
      return hasUnseenCompletion(thread)
        ? {
            kind: "done",
            label: "Done",
            colorClass: "text-emerald-600 dark:text-emerald-300/90",
            dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
            pulse: false,
          }
        : null;
  }
}

const CONTINUE_RANK: Record<HomeThreadStatus["kind"], number> = {
  approval: 0,
  input: 1,
  working: 2,
  failed: 3,
  done: 3,
};

/**
 * How much a chat asks for attention, lower first: an approval, a question,
 * working now, a result (or a failure) not dealt with yet, then everything else.
 */
export function continueRank(thread: HomeThread): number {
  const status = homeThreadStatus(thread);
  return status ? CONTINUE_RANK[status.kind] : 4;
}

/** The chats to pick up where the person left off: most urgent first, then most recent. */
export function pickContinueThreads(
  threads: ReadonlyArray<HomeThread>,
  { now, limit = 3 }: { now: number; limit?: number },
): HomeThread[] {
  return threads
    .filter((thread) => isHomeVisibleThread(thread, now))
    .filter((thread) => continueRank(thread) < 4 || thread.settledOverride !== "settled")
    .map((thread) => ({ thread, rank: continueRank(thread), at: threadActivityAt(thread) }))
    .toSorted((a, b) => a.rank - b.rank || b.at - a.at)
    .slice(0, limit)
    .map((entry) => entry.thread);
}

/** Chats waiting for the person: an approval or a question. Approvals first, newest first. */
export function attentionThreads(threads: ReadonlyArray<HomeThread>, now: number): HomeThread[] {
  return threads
    .filter(
      (thread) =>
        isHomeVisibleThread(thread, now) &&
        (thread.hasPendingApprovals || thread.hasPendingUserInput),
    )
    .toSorted(
      (a, b) =>
        Number(b.hasPendingApprovals) - Number(a.hasPendingApprovals) ||
        threadActivityAt(b) - threadActivityAt(a),
    );
}

/** The recent chats list: visible chats, newest first. */
export function recentThreads(
  threads: ReadonlyArray<HomeThread>,
  { now, limit = 8 }: { now: number; limit?: number },
): HomeThread[] {
  return threads
    .filter((thread) => isHomeVisibleThread(thread, now))
    .toSorted((a, b) => threadActivityAt(b) - threadActivityAt(a))
    .slice(0, limit);
}

/** "now", "12 min", "3 h", "2 d" — how long ago, short. */
export function shortAgo(ms: number, now: number): string {
  if (ms <= 0) return "";
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} d`;
}

export function greeting(hour: number): string {
  if (hour < 5) return "Good night";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// ---------------------------------------------------------------- widgets --

export const HOME_WIDGET_IDS = [
  "files",
  "apps",
  "computer",
  "needs-you",
  "recent-chats",
  "cloud",
  "sites",
  "ai-spend",
] as const;

export type HomeWidgetId = (typeof HOME_WIDGET_IDS)[number];

export const DEFAULT_HOME_WIDGETS: ReadonlyArray<HomeWidgetId> = ["files", "apps"];

export function isHomeWidgetId(value: unknown): value is HomeWidgetId {
  return typeof value === "string" && (HOME_WIDGET_IDS as ReadonlyArray<string>).includes(value);
}

/**
 * A stored layout, cleaned: known ids only, each once. Anything unreadable
 * gives the default layout, so a bad value in storage never blanks Home.
 */
export function normalizeHomeWidgets(raw: unknown): HomeWidgetId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_HOME_WIDGETS];
  const seen = new Set<HomeWidgetId>();
  for (const item of raw) {
    if (isHomeWidgetId(item)) seen.add(item);
  }
  return [...seen];
}

export type HomeWidgetsAction =
  | { readonly type: "add"; readonly id: HomeWidgetId }
  | { readonly type: "remove"; readonly id: HomeWidgetId }
  | { readonly type: "move"; readonly from: HomeWidgetId; readonly to: HomeWidgetId }
  | { readonly type: "reset" };

export function homeWidgetsReducer(
  state: ReadonlyArray<HomeWidgetId>,
  action: HomeWidgetsAction,
): HomeWidgetId[] {
  switch (action.type) {
    case "add":
      return state.includes(action.id) ? [...state] : [...state, action.id];
    case "remove":
      return state.filter((id) => id !== action.id);
    case "move": {
      const from = state.indexOf(action.from);
      const to = state.indexOf(action.to);
      if (from === -1 || to === -1 || from === to) return [...state];
      const next = [...state];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved!);
      return next;
    }
    case "reset":
      return [...DEFAULT_HOME_WIDGETS];
  }
}

/** Widgets that can still be added: not on Home yet and available here. */
export function addableWidgets(
  state: ReadonlyArray<HomeWidgetId>,
  available: ReadonlyArray<HomeWidgetId>,
): HomeWidgetId[] {
  return available.filter((id) => !state.includes(id));
}

// ------------------------------------------------------------------ files --

function modifiedMs(entry: { readonly modifiedAt: string }): number {
  const ms = Date.parse(entry.modifiedAt);
  return Number.isFinite(ms) ? ms : 0;
}

/** The home folder's latest-changed visible entries, newest first. */
export function recentHomeEntries<
  T extends { readonly name: string; readonly hidden: boolean; readonly modifiedAt: string },
>(entries: ReadonlyArray<T>, limit = 4): T[] {
  return entries
    .filter((entry) => !entry.hidden && !entry.name.startsWith("."))
    .toSorted((a, b) => modifiedMs(b) - modifiedMs(a))
    .slice(0, limit);
}

// -------------------------------------------------------------- approvals --

/**
 * An approval as one short question for a Needs-you row: "Run `npm i`?",
 * "Change files?". The subject is the agent's own detail, cut to one line.
 */
export function approvalQuestion(approval: {
  readonly requestKind: "command" | "file-read" | "file-change" | "other";
  readonly detail?: string | undefined;
}): { readonly lead: string; readonly subject: string | null } {
  const line = approval.detail?.trim().split("\n")[0]?.trim() ?? "";
  const subject = line ? (line.length > 80 ? `${line.slice(0, 79)}…` : line) : null;
  switch (approval.requestKind) {
    case "command":
      return subject ? { lead: "Run", subject } : { lead: "Run a command", subject: null };
    case "file-read":
      return subject ? { lead: "Read", subject } : { lead: "Read a file", subject: null };
    case "file-change":
      return subject ? { lead: "Change", subject } : { lead: "Change files", subject: null };
    case "other":
      return subject ? { lead: "Allow", subject } : { lead: "Go on", subject: null };
  }
}
