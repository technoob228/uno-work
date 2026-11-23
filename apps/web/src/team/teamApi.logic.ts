/**
 * T51 "Team in a project": the console's `/api/v1/work/team/*` answers
 * (snake_case, PLAN.md in reports/day_2026-11-20/team-collab) read into
 * typed objects. Tolerant: a missing or odd field reads as empty, never
 * throws — an older or newer server must not take the page down. Pure.
 *
 * @module team/teamApi.logic
 */
import { teamErrorCode } from "../components/projectSync/projectTeam.logic";

/** What of T51 is on for the caller (`GET collab`); each part is its own flag on the server. */
export interface TeamParts {
  /** (a) share a chat: read and write. */
  readonly share: boolean;
  /** (b) requests between people, "a session on your computer". */
  readonly requests: boolean;
  /** (c) levels up to "Answer questions", the journal. */
  readonly agents: boolean;
  /** (d) "Do tasks". */
  readonly tasks: boolean;
}

export const PARTS_OFF: TeamParts = { share: false, requests: false, agents: false, tasks: false };

export const anyPart = (parts: TeamParts) =>
  parts.share || parts.requests || parts.agents || parts.tasks;

export interface TeamPersonRef {
  readonly userId: number;
  readonly email: string | null;
  readonly username: string;
}

export type ShareLevel = "read" | "write";

/** How far colleagues' agents may go, low to high. */
export type AgentLevel = "off" | "ask" | "answer" | "tasks";
export const AGENT_LEVEL_ORDER: ReadonlyArray<AgentLevel> = ["off", "ask", "answer", "tasks"];

export type SharedChatStatus = "idle" | "running" | "waiting";

export interface ChatShareRow {
  readonly userId: number;
  readonly level: ShareLevel;
}

/** A chat mirrored to the Uno cloud (`work_shared_chats`). */
export interface SharedChat {
  readonly id: number;
  readonly projectId: number;
  readonly owner: TeamPersonRef | null;
  /** The environmentId of the owner's Work that runs it. */
  readonly source: string;
  readonly threadId: string;
  readonly title: string;
  /** The owner's computer, by name. */
  readonly computer: string;
  readonly status: SharedChatStatus;
  readonly updatedAt: string;
  readonly shares: ReadonlyArray<ChatShareRow>;
  /** Shared with me: what I may do. */
  readonly myLevel: ShareLevel | null;
}

export interface ProjectChats {
  readonly mine: ReadonlyArray<SharedChat>;
  readonly sharedWithMe: ReadonlyArray<SharedChat>;
}

export type FeedRole = "user" | "assistant" | "colleague" | "activity";

export interface FeedEvent {
  /** The change cursor: grows with every write. */
  readonly seq: number;
  /** The place in the feed. */
  readonly pos: number;
  readonly messageId: string | null;
  readonly role: FeedRole;
  /** A colleague's message: who wrote it. */
  readonly authorId: number | null;
  readonly text: string;
  readonly createdAt: string;
}

export interface FeedPage {
  readonly events: ReadonlyArray<FeedEvent>;
  readonly status: SharedChatStatus;
  readonly title: string;
  readonly nextSeq: number;
  /** More pages after this one: ask again at once. */
  readonly more: boolean;
  readonly myLevel: ShareLevel | null;
}

export type TeamRequestKind = "message" | "question" | "session" | "write_access";

export type TeamRequestStatus =
  | "waiting"
  | "started"
  | "declined"
  | "expired"
  | "answered"
  | "read"
  | "cancelled"
  | "refused"
  | "done"
  | "stopped";

export interface TeamRequest {
  readonly id: number;
  readonly rev: number;
  readonly projectId: number;
  readonly projectName: string;
  readonly from: TeamPersonRef | null;
  readonly to: TeamPersonRef | null;
  readonly kind: TeamRequestKind;
  readonly viaAgent: boolean;
  readonly fromChatTitle: string;
  readonly title: string;
  readonly gist: string;
  readonly body: string;
  /** The level it came in under. */
  readonly level: AgentLevel | null;
  /** What the level is now (inbox only). */
  readonly levelNow: AgentLevel | null;
  readonly auto: boolean;
  readonly status: TeamRequestStatus;
  readonly reason: string | null;
  readonly answer: string | null;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly decidedAt: string | null;
  /** write_access: which chat. */
  readonly chatId: number | null;
}

export interface InboxPage {
  readonly requests: ReadonlyArray<TeamRequest>;
  readonly rev: number;
}

export interface LevelSet {
  /** null — not set (the owner's ceiling: "ask"; mine: no limit). */
  readonly default: AgentLevel | null;
  readonly people: Readonly<Record<number, AgentLevel>>;
}

export interface TeamLevels {
  /** What the owner set for everyone (a ceiling). */
  readonly ceiling: LevelSet;
  /** "Lower for my computers". */
  readonly mine: LevelSet;
  /** What applies to requests from each person to me. */
  readonly effectiveIn: Readonly<Record<number, AgentLevel>>;
  /** What applies to my requests to each person. */
  readonly effectiveOut: Readonly<Record<number, AgentLevel>>;
  /** The caller is the owner. */
  readonly canSet: boolean;
}

export interface JournalEntry {
  readonly id: number;
  readonly at: string;
  readonly actor: TeamPersonRef | null;
  readonly target: TeamPersonRef | null;
  readonly kind: string;
  readonly viaAgent: boolean;
  readonly level: AgentLevel | null;
  readonly text: string;
}

// ── Readers ─────────────────────────────────────────────────────────────

type Rec = Readonly<Record<string, unknown>>;
const rec = (value: unknown): Rec =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
const arr = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const numOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const bool = (value: unknown): boolean => value === true;

const oneOf = <T extends string>(value: unknown, allowed: ReadonlyArray<T>): T | null =>
  typeof value === "string" && (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : null;

export const agentLevelOf = (value: unknown): AgentLevel | null => oneOf(value, AGENT_LEVEL_ORDER);
const shareLevelOf = (value: unknown): ShareLevel | null => oneOf(value, ["read", "write"]);

export function parseParts(body: unknown): TeamParts {
  const r = rec(body);
  return {
    share: bool(r["share"]),
    requests: bool(r["requests"]),
    agents: bool(r["agents"]),
    tasks: bool(r["tasks"]),
  };
}

/** A person, or a bare user id (an answer that only names the id). */
export function parsePerson(value: unknown): TeamPersonRef | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { userId: value, email: null, username: "" };
  }
  const r = rec(value);
  const userId = numOrNull(r["user_id"]);
  if (userId === null) return null;
  return { userId, email: strOrNull(r["email"]), username: str(r["username"]) };
}

const STATUSES: ReadonlyArray<SharedChatStatus> = ["idle", "running", "waiting"];

export function parseSharedChat(value: unknown): SharedChat | null {
  const r = rec(value);
  const id = numOrNull(r["id"]);
  if (id === null) return null;
  return {
    id,
    projectId: num(r["project_id"]),
    owner: parsePerson(r["owner"]),
    source: str(r["source"]),
    threadId: str(r["thread_id"]),
    title: str(r["title"]),
    computer: str(r["computer"]),
    status: oneOf(r["status"], STATUSES) ?? "idle",
    updatedAt: str(r["updated_at"]),
    shares: arr(r["shares"]).flatMap((item) => {
      const share = rec(item);
      const userId = numOrNull(share["user_id"]);
      const level = shareLevelOf(share["level"]);
      return userId !== null && level !== null ? [{ userId, level }] : [];
    }),
    myLevel: shareLevelOf(r["my_level"] ?? r["level"]),
  };
}

const chats = (value: unknown) =>
  arr(value).flatMap((item) => {
    const chat = parseSharedChat(item);
    return chat ? [chat] : [];
  });

export function parseProjectChats(body: unknown): ProjectChats {
  const r = rec(body);
  return { mine: chats(r["mine"]), sharedWithMe: chats(r["shared_with_me"]) };
}

const ROLES: ReadonlyArray<FeedRole> = ["user", "assistant", "colleague", "activity"];

export function parseFeedEvent(value: unknown): FeedEvent | null {
  const r = rec(value);
  const role = oneOf(r["role"], ROLES);
  const pos = numOrNull(r["pos"]);
  if (role === null || pos === null) return null;
  return {
    seq: num(r["seq"]),
    pos,
    messageId: strOrNull(r["message_id"]),
    role,
    authorId: numOrNull(r["author_id"]),
    text: str(r["text"]),
    createdAt: str(r["created_at"]),
  };
}

export function parseFeedPage(body: unknown): FeedPage {
  const r = rec(body);
  return {
    events: arr(r["events"]).flatMap((item) => {
      const event = parseFeedEvent(item);
      return event ? [event] : [];
    }),
    status: oneOf(r["status"], STATUSES) ?? "idle",
    title: str(r["title"]),
    nextSeq: num(r["next_seq"]),
    more: bool(r["more"]),
    myLevel: shareLevelOf(r["my_level"]),
  };
}

const KINDS: ReadonlyArray<TeamRequestKind> = ["message", "question", "session", "write_access"];
const REQUEST_STATUSES: ReadonlyArray<TeamRequestStatus> = [
  "waiting",
  "started",
  "declined",
  "expired",
  "answered",
  "read",
  "cancelled",
  "refused",
  "done",
  "stopped",
];

export function parseTeamRequest(value: unknown): TeamRequest | null {
  const r = rec(value);
  const id = numOrNull(r["id"]);
  const kind = oneOf(r["kind"], KINDS);
  const status = oneOf(r["status"], REQUEST_STATUSES);
  if (id === null || kind === null || status === null) return null;
  return {
    id,
    rev: num(r["rev"]),
    projectId: num(r["project_id"]),
    projectName: str(r["project_name"]),
    from: parsePerson(r["from"]),
    to: parsePerson(r["to"]),
    kind,
    viaAgent: bool(r["via_agent"]),
    fromChatTitle: str(r["from_chat_title"]),
    title: str(r["title"]),
    gist: str(r["gist"]),
    body: str(r["body"]),
    level: agentLevelOf(r["level"]),
    levelNow: agentLevelOf(r["level_now"]),
    auto: bool(r["auto"]),
    status,
    reason: strOrNull(r["reason"]),
    answer: strOrNull(r["answer"]),
    createdAt: str(r["created_at"]),
    expiresAt: strOrNull(r["expires_at"]),
    decidedAt: strOrNull(r["decided_at"]),
    chatId: numOrNull(r["chat_id"]),
  };
}

export function parseInboxPage(body: unknown): InboxPage {
  const r = rec(body);
  const requests = arr(r["requests"]).flatMap((item) => {
    const request = parseTeamRequest(item);
    return request ? [request] : [];
  });
  const top = requests.reduce((max, request) => Math.max(max, request.rev), 0);
  return { requests, rev: Math.max(num(r["rev"]), top) };
}

function levelMap(value: unknown): Readonly<Record<number, AgentLevel>> {
  const out: Record<number, AgentLevel> = {};
  for (const [key, level] of Object.entries(rec(value))) {
    const id = Number(key);
    const parsed = agentLevelOf(level);
    if (Number.isFinite(id) && parsed) out[id] = parsed;
  }
  return out;
}

function levelSet(value: unknown): LevelSet {
  const r = rec(value);
  return { default: agentLevelOf(r["default"]), people: levelMap(r["people"]) };
}

export function parseLevels(body: unknown): TeamLevels {
  const r = rec(body);
  return {
    ceiling: levelSet(r["ceiling"]),
    mine: levelSet(r["mine"]),
    effectiveIn: levelMap(r["effective_in"]),
    effectiveOut: levelMap(r["effective_out"]),
    canSet: bool(r["can_set"]),
  };
}

export function parseJournal(body: unknown): ReadonlyArray<JournalEntry> {
  return arr(rec(body)["entries"]).flatMap((item) => {
    const r = rec(item);
    const id = numOrNull(r["id"]);
    if (id === null) return [];
    return [
      {
        id,
        at: str(r["at"] ?? r["created_at"]),
        actor: parsePerson(r["actor"]),
        target: parsePerson(r["target"]),
        kind: str(r["kind"]),
        viaAgent: bool(r["via_agent"]),
        level: agentLevelOf(r["level"]),
        text: str(r["text"]),
      },
    ];
  });
}

// ── Refusals ────────────────────────────────────────────────────────────

/** T51 is off for this account (or teams are): draw nothing of it. */
export function isCollabOff(error: unknown): boolean {
  const code = teamErrorCode(error);
  return code === "WORK_TEAM_COLLAB_DISABLED" || code === "WORK_TEAM_DISABLED";
}

const MESSAGES: Readonly<Record<string, string>> = {
  PERSON_NOT_ENABLED: "They don't have this in their Uno Work yet.",
  NOT_SHARED: "This chat isn't shared any more.",
  NOT_MEMBER: "They're no longer in this project.",
  OWNER_ONLY: "Only the project's owner can do that.",
  LEVEL_OFF: "Their setting doesn't let agents reach them.",
  TOO_MANY_ROUNDS: "The agents went back and forth too long. Talk to each other first.",
  TOO_MANY_SESSIONS: "Two sessions from colleagues already run there.",
  CLAIMED: "Another of your computers already took this.",
  RATE_LIMITED: "That's a lot of messages. Try again in a while.",
  WRITE_NOT_ALLOWED: "You can only read this chat.",
  ALREADY_CAN_WRITE: "They can already write in this chat.",
  MESSAGE_RATE_LIMITED: "That's a lot of messages. Try again in a while.",
  REQUEST_RATE_LIMITED: "That's a lot of requests. Try again in a while.",
  REQUEST_NOT_WAITING: "This was already answered or ran out.",
  CANNOT_TARGET_SELF: "That's you.",
  BODY_TOO_LARGE: "That's too long. Make it shorter.",
  INVALID_FIELD: "Something in that didn't look right. Try again.",
  WORK_TEAM_COLLAB_DISABLED: "This isn't on for your account yet.",
  WORK_TEAM_DISABLED: "Teams aren't on for your account.",
};

export function teamCollabErrorMessage(error: unknown): string {
  const code = teamErrorCode(error);
  if (code && MESSAGES[code]) return MESSAGES[code];
  if ((error as { status?: unknown } | null)?.status === 429) return MESSAGES["RATE_LIMITED"]!;
  return "That didn't work. Try again in a moment.";
}
