/**
 * A chat with an open request — an Allow (approval) or a question — waits for
 * the person's answer in the chat itself. "Done" must never make that request
 * disappear: the card in the chat would stay unanswered and the agent (say, a
 * site publish) would wait forever. These are the pure rules every "Done"
 * (sidebar row, Home's Continue card, the Inbox bell and panel) follows.
 *
 * The truth is the chat's own summary (`hasPendingApprovals` /
 * `hasPendingUserInput`, kept by the server). An Inbox item's `readAt` is not:
 * opening the item marks it read without answering anything.
 */
import { INBOX_NEEDS_YOU_KINDS, type InboxItem, type InboxItemKind } from "@t3tools/contracts";

import type { SidebarThreadStatus } from "../components/Sidebar.logic";

/** What the chat's summary says is open; `undefined` when the chat is not known here. */
export interface ChatOpenRequests {
  readonly approval: boolean;
  readonly input: boolean;
}

/** The open requests from a chat's summary (absent when the chat is not known here). */
export function chatOpenRequests(
  summary:
    | { readonly hasPendingApprovals: boolean; readonly hasPendingUserInput: boolean }
    | undefined,
): ChatOpenRequests | undefined {
  return summary
    ? { approval: summary.hasPendingApprovals, input: summary.hasPendingUserInput }
    : undefined;
}

/** The agent waits on the person: an Allow or a question is open in the chat. */
export function chatWaitsForPerson(status: SidebarThreadStatus): boolean {
  return status === "approval" || status === "input";
}

/**
 * Whether to offer "Done" (settle) for a chat: not while it works, and not
 * while it waits for an answer — the server refuses both, and the request
 * card would stay unanswered.
 */
export function canOfferChatDone(status: SidebarThreadStatus): boolean {
  return status !== "working" && !chatWaitsForPerson(status);
}

/** Does this Inbox item stand for a request the chat still waits on? */
export function isOpenRequestItem(
  kind: InboxItemKind,
  open: ChatOpenRequests | undefined,
): boolean {
  if (!open) return false;
  if (kind === "agent.approval") return open.approval;
  if (kind === "agent.input") return open.input;
  return false;
}

/** "Done" / "Dismiss" on an Inbox item: not for a request that is still open. */
export function canDismissInboxItem(
  kind: InboxItemKind,
  open: ChatOpenRequests | undefined,
): boolean {
  return !isOpenRequestItem(kind, open);
}

/**
 * The Inbox items a chat's "Done" clears: its news, but never a request
 * (approval / question) the chat still waits on or that was never resolved.
 */
export function inboxIdsClearedByChatDone(
  items: ReadonlyArray<Pick<InboxItem, "id" | "kind" | "readAt" | "open">>,
  threadId: string,
  open: ChatOpenRequests | undefined,
): string[] {
  return items
    .filter(
      (item) =>
        item.open?.kind === "thread" &&
        item.open.threadId === threadId &&
        !isOpenRequestItem(item.kind, open) &&
        !(INBOX_NEEDS_YOU_KINDS.has(item.kind) && item.readAt === null),
    )
    .map((item) => item.id);
}

/**
 * Where an approval shown outside the chat (Home's Needs-you row, the bell)
 * stands:
 * - "pending": the request is known — Allow / Don't right here;
 * - "loading": the chat still waits for an OK but its details have not
 *   arrived yet — offer only Open (no Done: it would drop the request);
 * - "answered": nothing waits any more (or the chat is gone) — Open or Done.
 */
export type ApprovalPhase = "pending" | "loading" | "answered";

export function approvalPhase(input: {
  readonly requestKnown: boolean;
  readonly open: ChatOpenRequests | undefined;
}): ApprovalPhase {
  if (input.requestKnown) return "pending";
  if (input.open?.approval) return "loading";
  return "answered";
}
