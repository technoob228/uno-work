// Who a chat answers to right now: the person or an agent (Misha 28.10, the
// sidebar's "Only mine" filter). Chats the person started are always theirs.
// A chat an agent, Uno or an app started is the person's while it needs them:
// - it asks them something (an approval or a question);
// - an agent called them into it (`chat_call_person`) and they have not
//   pressed Read or Done, or written there, since;
// - it answers their own message and they have not pressed Read or Done on
//   that answer.
// Otherwise it is the agent's. Opening a chat does not hand it back, like
// "Your turn": one accidental click should not hide it.
import { isLatestTurnSettled } from "../session-logic";
import { isTurnRead } from "../threadReadMarks";
import type { SidebarThreadSummary } from "../types";
import { threadNeedsUser } from "./Sidebar.snooze";

export type ThreadOwner = "you" | "agent";

export type ThreadOwnerInput = Pick<
  SidebarThreadSummary,
  "hasPendingApprovals" | "hasPendingUserInput" | "latestTurn" | "session"
> &
  Partial<
    Pick<
      SidebarThreadSummary,
      | "latestUserMessageAt"
      | "settledOverride"
      | "settledAt"
      | "readAt"
      | "spawnedByThreadId"
      | "assistantRole"
      | "controller"
      | "startedBy"
      | "latestPersonMessageAt"
      | "personCalledAt"
    >
  >;

const ms = (iso: string | null | undefined) => Date.parse(iso ?? "");

/** Started by another chat's agent, by Uno or by an app, not by the person. */
export function isAgentStartedChat(
  thread: Pick<ThreadOwnerInput, "startedBy" | "spawnedByThreadId" | "assistantRole">,
): boolean {
  if (thread.assistantRole === "chat") return false;
  return (
    thread.startedBy != null ||
    thread.spawnedByThreadId != null ||
    thread.assistantRole === "spawned"
  );
}

/** Read, Done or a message of theirs at or after `atMs`. */
function personLookedSince(thread: ThreadOwnerInput, atMs: number): boolean {
  if (ms(thread.readAt) >= atMs) return true;
  if (thread.settledOverride === "settled" && ms(thread.settledAt) >= atMs) return true;
  return ms(thread.latestPersonMessageAt) > atMs;
}

/** An agent called the person in and they have not looked since. */
export function isPersonCallPending(thread: ThreadOwnerInput): boolean {
  const calledMs = ms(thread.personCalledAt);
  return !Number.isNaN(calledMs) && !personLookedSince(thread, calledMs);
}

/** The latest message that started a turn here is the person's, not an agent's. */
export function isAnsweringPerson(thread: ThreadOwnerInput): boolean {
  const personMs = ms(thread.latestPersonMessageAt);
  if (Number.isNaN(personMs)) return false;
  const userMs = ms(thread.latestUserMessageAt);
  return Number.isNaN(userMs) || personMs >= userMs;
}

/** The answer to the person's message is in and they pressed Read or Done on it. */
function personDoneWithAnswer(thread: ThreadOwnerInput): boolean {
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
  const completedAt = thread.latestTurn?.completedAt;
  const completedMs = ms(completedAt);
  if (Number.isNaN(completedMs) || completedMs < ms(thread.latestPersonMessageAt)) return false;
  if (isTurnRead(thread.readAt, completedAt)) return true;
  return thread.settledOverride === "settled" && ms(thread.settledAt) >= completedMs;
}

/**
 * `threadOwner` for a chat the sidebar knows an assistant started
 * (`useStartedBy`), even where the chat itself doesn't say so (Misha 29.10:
 * one Only mine, the assistants' chats with it).
 */
export function threadOwnerWithStarter(
  thread: ThreadOwnerInput,
  startedByAssistant: boolean,
): ThreadOwner {
  if (!startedByAssistant || thread.assistantRole === "chat" || isAgentStartedChat(thread)) {
    return threadOwner(thread);
  }
  // A daemon from before 28.10 says nothing (`undefined`): keep its fallback.
  return threadOwner(
    thread.startedBy === undefined
      ? { ...thread, assistantRole: "spawned" }
      : { ...thread, startedBy: "assistant" },
  );
}

export function threadOwner(thread: ThreadOwnerInput): ThreadOwner {
  if (!isAgentStartedChat(thread)) return "you";
  if (threadNeedsUser(thread)) return "you";
  // A server from before 28.10 knows neither the person's messages nor calls:
  // a chat stays the agent's until the person writes in it.
  if (thread.startedBy === undefined) return thread.controller === "human" ? "you" : "agent";
  if (isPersonCallPending(thread)) return "you";
  if (isAnsweringPerson(thread) && !personDoneWithAnswer(thread)) return "you";
  return "agent";
}
