/**
 * "Waiting for you" (T52) → the Inbox, the pure half: one item per chat
 * ("Waiting for you · 3: …", kind `agent.input`, Misha 23.11) that follows
 * the chat's list (`shell.pendingForYou`, kept by the projection):
 * - something new waits → the item is posted (or the unread one bumped);
 * - the list shrank but isn't empty → the unread item's line is updated;
 * - nothing waits → the item is read.
 * "New" is an item this daemon hasn't seen in the chat's list, created since
 * it started — a restart never re-posts what already waited.
 */
import { INBOX_PENDING_FOR_YOU_BODY_PREFIX, type ThreadPendingForYou } from "@t3tools/contracts";
import { pendingForYouSummary } from "@t3tools/shared/pendingForYou";

export function inboxPendingGroupKey(threadId: string): string {
  return `agent:${threadId}:pending`;
}

export function pendingItemBody(pending: ThreadPendingForYou): string {
  return `${INBOX_PENDING_FOR_YOU_BODY_PREFIX}${pending.items.length}: ${pendingForYouSummary(pending.items)}`;
}

export type InboxPendingAction =
  | { readonly type: "post"; readonly body: string }
  | { readonly type: "update"; readonly body: string }
  | { readonly type: "resolve" }
  | null;

export function inboxPendingAction(input: {
  /** Ids this daemon ever saw waiting in the chat (a restored item isn't news). */
  readonly everSeen: ReadonlySet<string>;
  /** Ids waiting the last time it looked; undefined: never looked since it started. */
  readonly lastIds: ReadonlyArray<string> | undefined;
  readonly pending: ThreadPendingForYou | null | undefined;
  /** When this daemon started (ISO). */
  readonly startedAt: string;
}): InboxPendingAction {
  const items = input.pending?.items ?? [];
  if (items.length === 0) {
    return input.lastIds === undefined || input.lastIds.length > 0 ? { type: "resolve" } : null;
  }
  const body = pendingItemBody(input.pending!);
  if (items.some((item) => !input.everSeen.has(item.id) && item.createdAt >= input.startedAt)) {
    return { type: "post", body };
  }
  const same =
    input.lastIds !== undefined &&
    input.lastIds.length === items.length &&
    items.every((item, index) => input.lastIds![index] === item.id);
  return same ? null : { type: "update", body };
}
