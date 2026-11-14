// The answers to the person's own messages they have not seen yet, folded
// onto the chats' sidebar summaries (`unreadAnswerAt`). The truth is the
// computer's Inbox: a turn that answered the person posts "Answer to your
// question", and it stays unread until they open the chat (the window in
// front), write there or press Done — whatever agents do in the chat after it
// (Misha 13.11: "I asked and left; agents talked; will I see my answer?").
import type { InboxItem, ThreadId } from "@t3tools/contracts";

import { isPersonAnswerItem } from "./inbox/openRequests.logic";
import type { SidebarThreadSummary } from "./types";

/** Chat → when its unread answer came, from an Inbox snapshot's items. */
export function unreadAnswersFromInbox(
  items: ReadonlyArray<Pick<InboxItem, "kind" | "body" | "readAt" | "open" | "updatedAt">>,
): ReadonlyMap<ThreadId, string> {
  const answers = new Map<ThreadId, string>();
  for (const item of items) {
    if (item.readAt !== null || item.open?.kind !== "thread" || !isPersonAnswerItem(item)) continue;
    const threadId = item.open.threadId as ThreadId;
    const known = answers.get(threadId);
    if (known === undefined || item.updatedAt > known) answers.set(threadId, item.updatedAt);
  }
  return answers;
}

export function sameUnreadAnswers(
  left: ReadonlyMap<ThreadId, string>,
  right: ReadonlyMap<ThreadId, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [threadId, at] of left) if (right.get(threadId) !== at) return false;
  return true;
}

/**
 * The summaries with `unreadAnswerAt` up to date. Returns the same record
 * (and the same summary objects) when nothing changed.
 */
export function withUnreadAnswers(
  byId: Record<ThreadId, SidebarThreadSummary>,
  answers: ReadonlyMap<ThreadId, string>,
): Record<ThreadId, SidebarThreadSummary> {
  let out = byId;
  for (const [id, summary] of Object.entries(byId) as Array<[ThreadId, SidebarThreadSummary]>) {
    const next = answers.get(id);
    if (summary.unreadAnswerAt === next) continue;
    if (out === byId) out = { ...byId };
    if (next === undefined) {
      const { unreadAnswerAt: _gone, ...rest } = summary;
      out[id] = rest;
    } else {
      out[id] = { ...summary, unreadAnswerAt: next };
    }
  }
  return out;
}
