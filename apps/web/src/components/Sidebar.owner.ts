// Who a chat answers to right now: the person or an agent (Misha 28.10, the
// sidebar's "Only mine" filter). Misha 20.11: a chat is yours if you started
// it or wrote in it recently; your coordinator is always in view.
// - A chat the person started is theirs (14.11), even while agents talk in it.
//   Then it is "waiting on agents": no Ready, no badge (Sidebar.yourTurn).
//   The safety net: their request waited for the chats this one started and
//   the last of them is done, which makes it Ready. And the answer to their
//   message holds: until they open the chat, write there or press Done, the
//   agents' turns after it don't take the Ready from them (T42, 13.11).
// - A chat an agent, Uno or an app started is the person's while they take
//   part in it: they wrote there in the last 24 hours (`PERSON_RECENT_MS`) or
//   pressed Join then, and it is their coordinator — it runs agents of its own
//   and they wrote there or joined it, whenever that was. Their automation's
//   message does not count: in a chat an agent started, only their own message
//   or Join takes it from the agent (`controller`).
// - It is also theirs while it needs them: it asks them something (an approval
//   or a question); an agent called them into it (`chat_call_person`) and they
//   have not pressed Read or Done, or written there, since; it answers their
//   message (or their automation's) and they have not pressed Read or Done on
//   that answer.
// - Otherwise it is the agent's. Opening a chat does not hand it back, like
//   "Your turn": one accidental click should not hide it.
// - Hand to agent (14.11) makes any chat the agent's, except while it needs
//   them (a question, an approval, a call), until they write there or Join.
// - Uno's own chat is always theirs.
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
      | "controlChangedAt"
      | "startedBy"
      | "latestPersonMessageAt"
      | "personCalledAt"
      | "childWork"
      | "unreadAnswerAt"
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

/**
 * The answer to the person's message is in and they have not seen it: the
 * Inbox item is unread (opening the chat reads it) and they pressed neither
 * Read nor Done, nor wrote, since it came.
 */
export function hasUnreadAnswer(thread: ThreadOwnerInput): boolean {
  const answeredMs = ms(thread.unreadAnswerAt);
  return !Number.isNaN(answeredMs) && !personLookedSince(thread, answeredMs);
}

/** The latest message that started a turn here is the person's, not an agent's. */
export function isAnsweringPerson(thread: ThreadOwnerInput): boolean {
  const personMs = ms(thread.latestPersonMessageAt);
  if (Number.isNaN(personMs)) return false;
  const userMs = ms(thread.latestUserMessageAt);
  return Number.isNaN(userMs) || personMs >= userMs;
}

/**
 * The person asked something here and the chats started for it since are
 * all done: the request is answered, even if the agent's last turn answered
 * one of them, not the person.
 */
export function areChildChatsDoneSinceRequest(thread: ThreadOwnerInput): boolean {
  const work = thread.childWork;
  if (work === undefined || work.working > 0) return false;
  const personMs = ms(thread.latestPersonMessageAt);
  return !Number.isNaN(personMs) && ms(work.latestStartedAt) >= personMs;
}

/**
 * A chat the person started where agents talk among themselves (see the top
 * of the file). A daemon from before 28.10 knows no authors, and a chat with
 * no message of the person's on record (older than 28.10's backfill): as
 * before, never.
 */
export function isWaitingOnAgents(thread: ThreadOwnerInput): boolean {
  if (isAgentStartedChat(thread)) return false;
  if (thread.startedBy === undefined || thread.latestPersonMessageAt == null) return false;
  if (isAnsweringPerson(thread) || hasUnreadAnswer(thread)) return false;
  if (threadNeedsUser(thread) || isPersonCallPending(thread)) return false;
  return !areChildChatsDoneSinceRequest(thread);
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
 * How long the person's own message (or Join) keeps an agent's chat theirs
 * (Misha 20.11: "if you wrote in it recently"). A day: a chat they worked in
 * today or last night stays in Only mine overnight; one they left for a day
 * goes back to its agent. Not "until an agent writes" — that was T42, which
 * hid a chat the person was in the middle of.
 */
export const PERSON_RECENT_MS = 24 * 60 * 60 * 1_000;

/** The person handed it to its agent (Hand to agent, 14.11) and has not taken it back. */
function isHandedToAgent(thread: ThreadOwnerInput): boolean {
  return thread.controller === "agent" && thread.controlChangedAt != null;
}

/**
 * When the person last took part in a chat an agent, Uno or an app started:
 * their own message or Join. NaN while its agent handles it: a chat another
 * chat's agent started is the agent's (`controller`) until they write there
 * or Join, so their automation's message (in `latestPersonMessageAt` too)
 * does not count; and Hand to agent ends it.
 */
function personTookPartAtMs(thread: ThreadOwnerInput): number {
  if (thread.controller === "agent") return Number.NaN;
  const wroteMs = ms(thread.latestPersonMessageAt);
  const joinedMs = thread.controller === "human" ? ms(thread.controlChangedAt) : Number.NaN;
  if (Number.isNaN(wroteMs)) return joinedMs;
  return Number.isNaN(joinedMs) ? wroteMs : Math.max(wroteMs, joinedMs);
}

/** The person wrote in (or joined) this agent's chat within `PERSON_RECENT_MS`. */
export function personTookPartRecently(thread: ThreadOwnerInput, nowMs: number): boolean {
  const atMs = personTookPartAtMs(thread);
  return !Number.isNaN(atMs) && nowMs - atMs < PERSON_RECENT_MS;
}

/**
 * The person's coordinator among the agents' chats: one they wrote in or
 * joined that runs agents of its own (it started chats). Always theirs, like
 * a coordinator they started themselves (Misha 20.11).
 */
export function isPersonsCoordinator(thread: ThreadOwnerInput): boolean {
  return thread.childWork !== undefined && !Number.isNaN(personTookPartAtMs(thread));
}

/**
 * `threadOwner` for a chat the sidebar knows an assistant started
 * (`useStartedBy`), even where the chat itself doesn't say so (Misha 29.10:
 * one Only mine, the assistants' chats with it).
 */
export function threadOwnerWithStarter(
  thread: ThreadOwnerInput,
  startedByAssistant: boolean,
  nowMs: number = Date.now(),
): ThreadOwner {
  if (!startedByAssistant || thread.assistantRole === "chat" || isAgentStartedChat(thread)) {
    return threadOwner(thread, nowMs);
  }
  // A daemon from before 28.10 says nothing (`undefined`): keep its fallback.
  return threadOwner(
    thread.startedBy === undefined
      ? { ...thread, assistantRole: "spawned" }
      : { ...thread, startedBy: "assistant" },
    nowMs,
  );
}

/** See the top of the file. `nowMs` dates "recently". */
export function threadOwner(thread: ThreadOwnerInput, nowMs: number = Date.now()): ThreadOwner {
  if (thread.assistantRole === "chat") return "you";
  if (isHandedToAgent(thread)) {
    return threadNeedsUser(thread) || isPersonCallPending(thread) ? "you" : "agent";
  }
  if (!isAgentStartedChat(thread)) return "you";
  if (threadNeedsUser(thread)) return "you";
  // A server from before 28.10 knows neither the person's messages nor calls:
  // a chat stays the agent's until the person writes in it.
  if (thread.startedBy === undefined) return thread.controller === "human" ? "you" : "agent";
  if (isPersonCallPending(thread) || hasUnreadAnswer(thread)) return "you";
  if (isPersonsCoordinator(thread) || personTookPartRecently(thread, nowMs)) return "you";
  if (
    (isAnsweringPerson(thread) || areChildChatsDoneSinceRequest(thread)) &&
    !personDoneWithAnswer(thread)
  ) {
    return "you";
  }
  return "agent";
}
