// "Your turn": a chat finished its work and now waits for the person — to
// reply, or to say it's done. Looking at the chat does not clear it (that was
// the old "unread" green dot, gone after one accidental click); only a new
// message (the chat works again) or Done (the server-backed settle) does, so
// it reads the same on the desktop app and in the browser.
import { isAssistantProjectId } from "@t3tools/contracts";

import { isLatestTurnSettled } from "../session-logic";
import type { SidebarThreadSummary } from "../types";
import { isThreadSnoozed, threadNeedsUser } from "./Sidebar.snooze";

/**
 * Turns finished before this moment never count: when "Your turn" shipped
 * (02.10.2026), chats older than three days were taken as done, so the list
 * didn't light up with months of history.
 */
export const YOUR_TURN_SINCE = "2026-09-29T00:00:00.000Z";
const YOUR_TURN_SINCE_MS = Date.parse(YOUR_TURN_SINCE);

export type YourTurnInput = Pick<
  SidebarThreadSummary,
  "hasPendingApprovals" | "hasPendingUserInput" | "latestTurn" | "session"
> &
  Partial<
    Pick<
      SidebarThreadSummary,
      | "latestUserMessageAt"
      | "snoozedUntil"
      | "snoozedAt"
      | "settledOverride"
      | "settledAt"
      | "projectId"
      | "spawnedByThreadId"
    >
  >;

export function isYourTurn(thread: YourTurnInput, now: string): boolean {
  // Assistant chats answer in Telegram/Slack or the Uno chat; chats another
  // agent started report back to that agent's chat, which is the one to answer.
  if (thread.projectId != null && isAssistantProjectId(thread.projectId)) return false;
  if (thread.spawnedByThreadId != null) return false;
  // An approval or a question has its own, louder status.
  if (threadNeedsUser(thread)) return false;
  const session = thread.session;
  if (
    session?.status === "running" ||
    session?.status === "connecting" ||
    session?.orchestrationStatus === "running" ||
    session?.orchestrationStatus === "starting"
  ) {
    return false;
  }
  if (!isLatestTurnSettled(thread.latestTurn, session)) return false;
  const completedAtMs = Date.parse(thread.latestTurn?.completedAt ?? "");
  if (Number.isNaN(completedAtMs) || completedAtMs < YOUR_TURN_SINCE_MS) return false;
  // The person already wrote again: that turn is on its way, not on them.
  const userMessageMs = Date.parse(thread.latestUserMessageAt ?? "");
  if (!Number.isNaN(userMessageMs) && userMessageMs > completedAtMs) return false;
  // Done for this turn. A later turn wakes the chat (the server also clears the
  // settle on activity; this covers the moment before that event arrives).
  if (thread.settledOverride === "settled") {
    const settledAtMs = Date.parse(thread.settledAt ?? "");
    if (Number.isNaN(settledAtMs) || settledAtMs >= completedAtMs) return false;
  }
  return !isThreadSnoozed(thread, now);
}

/** Chats waiting on the person: an approval, a question, or their turn. Drives the Dock badge. */
export function countChatsWaitingOnYou(
  threads: ReadonlyArray<YourTurnInput & Pick<SidebarThreadSummary, "archivedAt">>,
  now: string,
): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    if (threadNeedsUser(thread) || isYourTurn(thread, now)) count += 1;
  }
  return count;
}
