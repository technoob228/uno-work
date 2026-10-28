// "Your turn": a chat finished its work and now waits for the person — to
// reply, or to say it's done. Looking at the chat does not clear it (that was
// the old "unread" green dot, gone after one accidental click); only a new
// message (the chat works again), Done (the server-backed settle, so it reads
// the same on the desktop app and in the browser) or Read (this browser's
// mark: seen, nothing to add, the chat stays in its place) does.
import { isAssistantProjectId } from "@t3tools/contracts";

import { isLatestTurnSettled } from "../session-logic";
import { isTurnRead } from "../threadReadMarks";
import type { SidebarThreadSummary } from "../types";
import {
  isAgentStartedChat,
  isAnsweringPerson,
  isPersonCallPending,
  type ThreadOwnerInput,
} from "./Sidebar.owner";
import { isThreadSnoozed, threadNeedsUser } from "./Sidebar.snooze";

/**
 * Turns finished before this moment never count: when "Your turn" shipped
 * (02.10.2026), chats older than three days were taken as done, so the list
 * didn't light up with months of history.
 */
export const YOUR_TURN_SINCE = "2026-09-29T00:00:00.000Z";
const YOUR_TURN_SINCE_MS = Date.parse(YOUR_TURN_SINCE);

export type YourTurnInput = ThreadOwnerInput &
  Partial<
    Pick<
      SidebarThreadSummary,
      | "latestUserMessageAt"
      | "snoozedUntil"
      | "snoozedAt"
      | "settledOverride"
      | "settledAt"
      | "readAt"
      | "projectId"
      | "spawnedByThreadId"
    >
  >;

export function isYourTurn(thread: YourTurnInput, now: string): boolean {
  // A chat an agent or Uno started reports back to the chat that started it,
  // which is the one to answer, unless it called the person in or answers
  // their own message (Sidebar.owner). The person's other assistant chats
  // answer in Telegram/Slack or the Uno chat.
  const calledIn = isPersonCallPending(thread);
  if (isAgentStartedChat(thread)) {
    if (!calledIn && !isAnsweringPerson(thread)) return false;
  } else if (thread.projectId != null && isAssistantProjectId(thread.projectId)) {
    return false;
  }
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
  // Called in after the turn finished: Read or Done before the call does not count.
  if (calledIn) return !isThreadSnoozed(thread, now);
  // Done for this turn. A later turn wakes the chat (the server also clears the
  // settle on activity; this covers the moment before that event arrives).
  if (thread.settledOverride === "settled") {
    const settledAtMs = Date.parse(thread.settledAt ?? "");
    if (Number.isNaN(settledAtMs) || settledAtMs >= completedAtMs) return false;
  }
  // Read: seen, and no turn finished since.
  if (isTurnRead(thread.readAt, thread.latestTurn?.completedAt)) return false;
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
