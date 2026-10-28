/**
 * Which actions an Inbox item ("Needs you") offers, by why the agent needs
 * the person. One rule for the bell, the Inbox panel and Home, so the words
 * are the same everywhere:
 *
 * - an approval (`agent.approval`) — Allow / Decline right there, View opens
 *   the chat. While the request's details are still on their way: View only.
 *   Once answered: View and Done.
 * - a question (`agent.input`: a question, a secret to paste, a call for help
 *   in the browser) — Open chat, and Skip for now (the Inbox item is snoozed:
 *   it comes back unread later). Never Done / Dismiss / Mark read while it
 *   waits: the agent would keep waiting with nothing in the Inbox.
 * - everything else (finished, failed, an app's news) — as before: Open,
 *   Done, Snooze, Mark read.
 *
 * Pure: the caller knows the chat's open requests and the approval's phase.
 */
import type { InboxItemKind } from "@t3tools/contracts";

import { resolveSnoozePresets, type SnoozePreset } from "../components/Sidebar.snooze";
import { type ApprovalPhase, type ChatOpenRequests, isOpenRequestItem } from "./openRequests.logic";

export type InboxActionReason = "approval" | "question" | "other";

/** Buttons, in the order they are shown. */
export type InboxButton = "allow" | "decline" | "view" | "open-chat" | "open";

export const INBOX_BUTTON_LABEL: Readonly<Record<InboxButton, string>> = {
  allow: "Allow",
  decline: "Decline",
  view: "View",
  "open-chat": "Open chat",
  open: "Open",
};

export const SKIP_FOR_NOW_LABEL = "Skip for now";

export interface InboxItemActions {
  readonly reason: InboxActionReason;
  readonly buttons: ReadonlyArray<InboxButton>;
  /** "Skip for now" menu (1 hour / This evening / Tomorrow morning) — snoozes the item. */
  readonly skip: boolean;
  /** Done / Dismiss. */
  readonly done: boolean;
  /** The general Snooze / "Remind me" menu. */
  readonly snooze: boolean;
  /** Mark read / unread. */
  readonly markRead: boolean;
}

export interface InboxActionsInput {
  readonly kind: InboxItemKind;
  /** The item opens a chat (approvals and questions are answered there). */
  readonly hasThread: boolean;
  readonly unread: boolean;
  /** What the chat's summary says is open; undefined when the chat is not known here. */
  readonly open: ChatOpenRequests | undefined;
  /** Approvals only: where the request stands (`usePendingApproval`). */
  readonly approvalPhase?: ApprovalPhase | null;
  /**
   * Approvals only: the row itself can be answered (`POST
   * /api/uno-work/approval/from-inbox`) — an "Cautious" request that waits
   * with no chat card to answer (assistants D). Only while the row is unread:
   * the daemon keeps it unread until the person answers.
   */
  readonly answerableByRow?: boolean;
}

const OTHER: InboxItemActions = {
  reason: "other",
  buttons: ["open"],
  skip: false,
  done: true,
  snooze: true,
  markRead: true,
};

export function inboxActionReason(kind: InboxItemKind): InboxActionReason {
  if (kind === "agent.approval") return "approval";
  if (kind === "agent.input") return "question";
  return "other";
}

/**
 * A question still waits when the chat says so — or, for requests the chat's
 * summary doesn't track (a secret to paste, help in the browser), while the
 * item is unread: answering marks it read on the daemon.
 */
export function questionWaits(input: Pick<InboxActionsInput, "kind" | "unread" | "open">): boolean {
  return input.unread || isOpenRequestItem(input.kind, input.open);
}

export function resolveInboxItemActions(input: InboxActionsInput): InboxItemActions {
  const reason = inboxActionReason(input.kind);
  if (
    reason === "approval" &&
    input.answerableByRow === true &&
    input.unread &&
    input.approvalPhase !== "pending" &&
    input.approvalPhase !== "loading"
  ) {
    // The chat knows no card for it (or there is no chat): Allow / Decline by the row.
    return {
      reason,
      buttons: input.hasThread ? ["allow", "decline", "view"] : ["allow", "decline"],
      skip: false,
      done: false,
      snooze: false,
      markRead: false,
    };
  }
  if (reason === "other" || !input.hasThread) return OTHER;

  if (reason === "approval") {
    const phase = input.approvalPhase ?? "answered";
    if (phase === "pending") {
      return {
        reason,
        buttons: ["allow", "decline", "view"],
        skip: false,
        done: false,
        snooze: false,
        markRead: false,
      };
    }
    if (phase === "loading") {
      // Still waits, details on their way: View only — Done would drop the request.
      return {
        reason,
        buttons: ["view"],
        skip: false,
        done: false,
        snooze: false,
        markRead: false,
      };
    }
    return { reason, buttons: ["view"], skip: false, done: true, snooze: false, markRead: true };
  }

  if (questionWaits(input)) {
    return {
      reason,
      buttons: ["open-chat"],
      skip: true,
      done: false,
      snooze: false,
      markRead: false,
    };
  }
  // Answered: nothing to skip any more — open it or clear it.
  return { reason, buttons: ["open-chat"], skip: false, done: true, snooze: false, markRead: true };
}

/** "Skip for now" choices: 1 hour, This evening (while it's ahead), Tomorrow morning. */
export function skipForNowPresets(now: Date): ReadonlyArray<SnoozePreset> {
  return resolveSnoozePresets(now).filter((preset) => preset.id !== "next-week");
}

/** The part of an Inbox item Home's Needs-you list reads. */
export interface NeedsYouInboxItem {
  readonly id: string;
  readonly environmentId: string;
  readonly kind: string;
  readonly updatedAt: string;
  readonly readAt: string | null;
  readonly snoozedUntil: string | null;
  readonly open: { readonly kind: string; readonly threadId?: string } | null;
}

export function threadKey(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

/** Question items per chat, newest first. */
function questionItemsByThread<I extends NeedsYouInboxItem>(
  items: ReadonlyArray<I>,
): Map<string, I[]> {
  const out = new Map<string, I[]>();
  for (const item of items) {
    if (item.kind !== "agent.input" || item.open?.kind !== "thread" || !item.open.threadId) {
      continue;
    }
    const key = threadKey(item.environmentId, item.open.threadId);
    const list = out.get(key);
    if (list) list.push(item);
    else out.set(key, [item]);
  }
  for (const list of out.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

const snoozedAt = (item: NeedsYouInboxItem, now: number) =>
  item.snoozedUntil !== null && Date.parse(item.snoozedUntil) > now;

/**
 * Chats (`environmentId:threadId`) whose question was skipped for now: the
 * newest question item is snoozed and no other one waits unread. A new
 * question un-snoozes the item on the daemon (or adds a new one), so the chat
 * comes back by itself; so does the wake-up time.
 */
export function skippedQuestionThreadKeys(
  items: ReadonlyArray<NeedsYouInboxItem>,
  now: number,
): Set<string> {
  const out = new Set<string>();
  for (const [key, list] of questionItemsByThread(items)) {
    const newest = list[0];
    if (!newest || !snoozedAt(newest, now)) continue;
    if (list.some((item) => item.readAt === null && !snoozedAt(item, now))) continue;
    out.add(key);
  }
  return out;
}

/**
 * The question items "Skip for now" on a chat snoozes: every one still
 * unread, and the newest even if it was opened already (opening reads it).
 * Older read ones stay as they are — snoozing would bring an answered
 * question back unread. Empty → there is nothing to skip with.
 */
export function questionItemIdsToSkip(
  items: ReadonlyArray<NeedsYouInboxItem>,
  environmentId: string,
  threadId: string,
  now: number,
): string[] {
  const list = questionItemsByThread(items).get(threadKey(environmentId, threadId)) ?? [];
  return list
    .filter((item, index) => !snoozedAt(item, now) && (index === 0 || item.readAt === null))
    .map((item) => item.id);
}
