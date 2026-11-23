/**
 * T51 "Team in a project" from the interface: `/api/v1/work/team/*` with the
 * person's own sign-in (`accountRequest` — the desktop bridge or the Work
 * proxy's `/_account`). Sharing, deciding, writing in a colleague's chat and
 * setting levels are the person's acts: never through a daemon, whose machine
 * key the server doesn't let into these routes.
 *
 * @module team/teamApi
 */
import { accountRequest, accountTransport } from "../account/unoAccount";
import {
  PARTS_OFF,
  isCollabOff,
  parseFeedPage,
  parseInboxPage,
  parseJournal,
  parseLevels,
  parseParts,
  parseProjectChats,
  parseSharedChat,
  type AgentLevel,
  type FeedPage,
  type InboxPage,
  type JournalEntry,
  type ProjectChats,
  type SharedChat,
  type TeamParts,
  type TeamLevels,
} from "./teamApi.logic";
import type { ShareChoice } from "./team.logic";

const ROOT = "/api/v1/work/team";

/** What of T51 is on for me; all off when it isn't (or there's no sign-in here). */
export async function loadParts(): Promise<TeamParts> {
  if (accountTransport() === "none") return PARTS_OFF;
  try {
    return parseParts(await accountRequest("GET", `${ROOT}/collab`));
  } catch (error) {
    if (isCollabOff(error)) return PARTS_OFF;
    // A server without the route (404 with no code) is a server without T51.
    if ((error as { status?: unknown } | null)?.status === 404) return PARTS_OFF;
    throw error;
  }
}

export async function loadMyId(): Promise<number | null> {
  if (accountTransport() === "none") return null;
  const me = (await accountRequest("GET", "/auth/me")) as { id?: unknown } | null;
  return typeof me?.id === "number" ? me.id : null;
}

// ── (a) Shared chats ────────────────────────────────────────────────────

export const loadProjectChats = async (projectId: number): Promise<ProjectChats> =>
  parseProjectChats(await accountRequest("GET", `${ROOT}/projects/${projectId}/chats`));

export interface ShareInput {
  readonly projectId: number;
  /** The environmentId of the Work that runs the chat. */
  readonly source: string;
  readonly threadId: string;
  readonly title: string;
  readonly computer: string;
  readonly userId: number;
  readonly level: ShareChoice;
}

export async function shareChat(input: ShareInput): Promise<SharedChat | null> {
  const answer = (await accountRequest("PUT", `${ROOT}/projects/${input.projectId}/chats/share`, {
    source: input.source,
    thread_id: input.threadId,
    title: input.title.slice(0, 200),
    computer: input.computer.slice(0, 120),
    user_id: input.userId,
    level: input.level,
  })) as { chat?: unknown } | null;
  return parseSharedChat(answer?.chat);
}

/** The owner stops sharing the chat with everyone. */
export const stopSharingChat = (chatId: number) =>
  accountRequest("DELETE", `${ROOT}/chats/${chatId}`);

/** Long poll: what changed after `afterSeq`; waits up to `waitSeconds` when nothing did. */
export async function loadFeed(
  chatId: number,
  afterSeq: number,
  waitSeconds: number,
): Promise<FeedPage> {
  const query = `after_seq=${afterSeq}&wait=${Math.max(0, Math.min(25, waitSeconds))}`;
  return parseFeedPage(await accountRequest("GET", `${ROOT}/chats/${chatId}/events?${query}`));
}

/** A colleague with "Can write" writes in the chat: it goes to the owner's agent as theirs. */
export const writeInSharedChat = (chatId: number, text: string) =>
  accountRequest("POST", `${ROOT}/chats/${chatId}/messages`, { text });

// ── (b) Requests between people ─────────────────────────────────────────

export interface PersonRequestInput {
  readonly projectId: number;
  readonly to: number;
  readonly kind: "message" | "write_access";
  readonly text: string;
  readonly title?: string;
  readonly chatId?: number;
}

export const sendPersonRequest = (input: PersonRequestInput) =>
  accountRequest("POST", `${ROOT}/projects/${input.projectId}/requests`, {
    to: input.to,
    kind: input.kind,
    text: input.text,
    ...(input.title ? { title: input.title } : {}),
    ...(input.chatId !== undefined ? { chat_id: input.chatId } : {}),
  });

export async function loadInbox(afterRev: number, waitSeconds: number): Promise<InboxPage> {
  const query = `after_rev=${afterRev}&wait=${Math.max(0, Math.min(25, waitSeconds))}`;
  return parseInboxPage(await accountRequest("GET", `${ROOT}/requests/inbox?${query}`));
}

export type RequestDecision = "read" | "declined" | "answer" | "allow" | "deny";

export const decideRequest = (requestId: number, decision: RequestDecision, text?: string) =>
  accountRequest("POST", `${ROOT}/requests/${requestId}/decide`, {
    decision,
    ...(text ? { text } : {}),
  });

export const cancelRequest = (requestId: number) =>
  accountRequest("POST", `${ROOT}/requests/${requestId}/cancel`);

// ── (c) Levels and the journal ──────────────────────────────────────────

export const loadLevels = async (projectId: number): Promise<TeamLevels> =>
  parseLevels(await accountRequest("GET", `${ROOT}/projects/${projectId}/levels`));

/** The owner: the ceiling for everyone (`senderId` 0) or one person; null clears it. */
export const setCeilingLevel = (projectId: number, senderId: number, level: AgentLevel | null) =>
  accountRequest("PUT", `${ROOT}/projects/${projectId}/levels`, { sender_id: senderId, level });

/** Anyone: lower it for my own computers; null — as the owner set. */
export const setMyLevel = (projectId: number, senderId: number, level: AgentLevel | null) =>
  accountRequest("PUT", `${ROOT}/projects/${projectId}/levels/mine`, {
    sender_id: senderId,
    level,
  });

export const loadJournal = async (projectId: number): Promise<ReadonlyArray<JournalEntry>> =>
  parseJournal(await accountRequest("GET", `${ROOT}/projects/${projectId}/journal`));
