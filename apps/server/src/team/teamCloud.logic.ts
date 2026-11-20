/**
 * The Uno cloud's T51 answers (fishcode `/api/v1/work/team/…`, snake_case,
 * PLAN.md "API") read into this daemon's shapes. Pure and forgiving: a field
 * that isn't there or has the wrong type is left out, never thrown on — the
 * server is built in parallel and may add fields.
 *
 * @module team/teamCloud.logic
 */
import type { TeamAgentLevel, TeamChatStatus, TeamParts } from "@t3tools/contracts";

export const NO_PARTS: TeamParts = { share: false, requests: false, agents: false, tasks: false };

export const LEVEL_ORDER: ReadonlyArray<TeamAgentLevel> = ["off", "ask", "answer", "tasks"];

export const isLevel = (value: unknown): value is TeamAgentLevel =>
  typeof value === "string" && (LEVEL_ORDER as ReadonlyArray<string>).includes(value);

export const levelAtLeast = (level: TeamAgentLevel, floor: TeamAgentLevel) =>
  LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(floor);

export interface TeamPerson {
  readonly userId: number;
  readonly email: string | null;
  readonly username: string | null;
}

export interface TeamProject {
  readonly id: number;
  readonly name: string;
  readonly role: "owner" | "editor";
}

export interface TeamMember extends TeamPerson {
  readonly role: "owner" | "editor";
}

export interface SharedChat {
  readonly id: number;
  readonly projectId: number;
  readonly source: string;
  readonly threadId: string;
  readonly title: string;
  readonly status: TeamChatStatus;
  readonly shares: ReadonlyArray<{ readonly userId: number; readonly level: "read" | "write" }>;
}

export interface InboundMessage {
  readonly id: number;
  readonly chatId: number;
  readonly threadId: string;
  readonly from: TeamPerson;
  readonly text: string;
  readonly createdAt: string;
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
  readonly from: TeamPerson;
  readonly to: TeamPerson;
  readonly kind: TeamRequestKind;
  readonly viaAgent: boolean;
  readonly fromChatTitle: string;
  /** `from_thread`: the asking chat on the sender's computer (outgoing only). */
  readonly fromThread: string | null;
  readonly title: string;
  readonly gist: string;
  readonly body: string;
  readonly level: TeamAgentLevel;
  /** The level as it is now (inbox), else `level`. */
  readonly levelNow: TeamAgentLevel;
  readonly auto: boolean;
  readonly status: TeamRequestStatus;
  readonly reason: string | null;
  readonly answer: string | null;
  readonly threadTitle: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly stopRequested: boolean;
  readonly chatId: number | null;
}

export interface TeamLevels {
  readonly effectiveIn: Readonly<Record<string, TeamAgentLevel>>;
  readonly effectiveOut: Readonly<Record<string, TeamAgentLevel>>;
}

type Json = Record<string, unknown>;

const obj = (value: unknown): Json | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
const arr = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const int = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : null;
const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const textOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

const STATUSES: ReadonlySet<string> = new Set([
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
]);
const KINDS: ReadonlySet<string> = new Set(["message", "question", "session", "write_access"]);

/** `GET collab` → `{share, requests, agents, tasks}`; anything else: all off. */
export function parseParts(body: unknown): TeamParts {
  const value = obj(body);
  if (value === null) return NO_PARTS;
  return {
    share: value["share"] === true,
    requests: value["requests"] === true,
    agents: value["agents"] === true,
    tasks: value["tasks"] === true,
  };
}

export const anyPart = (parts: TeamParts) =>
  parts.share || parts.requests || parts.agents || parts.tasks;

export function parsePerson(value: unknown): TeamPerson | null {
  const person = obj(value);
  const userId = int(person?.["user_id"]);
  if (person === null || userId === null) return null;
  return {
    userId,
    email: textOrNull(person["email"]),
    username: textOrNull(person["username"]),
  };
}

/** How a colleague is called in a sentence: their username, their email's name, or "A colleague". */
export function personName(person: TeamPerson | null): string {
  const username = person?.username?.trim();
  if (username) return username;
  const email = person?.email?.trim();
  if (email) return email.split("@")[0] || email;
  return "A colleague";
}

/** `GET /api/v1/work/team/projects` → the projects this person is in. */
export function parseProjects(body: unknown): ReadonlyArray<TeamProject> {
  return arr(obj(body)?.["projects"]).flatMap((raw) => {
    const project = obj(raw);
    const id = int(project?.["id"]);
    const role = project?.["role"];
    if (project === null || id === null || typeof project["name"] !== "string") return [];
    if (role !== "owner" && role !== "editor") return [];
    return [{ id, name: project["name"], role }];
  });
}

/** `GET /api/v1/work/team/projects/{id}` → its people. */
export function parseMembers(body: unknown): ReadonlyArray<TeamMember> {
  return arr(obj(body)?.["members"]).flatMap((raw) => {
    const person = parsePerson(raw);
    const role = obj(raw)?.["role"];
    if (person === null || (role !== "owner" && role !== "editor")) return [];
    return [{ ...person, role }];
  });
}

const chatStatus = (value: unknown): TeamChatStatus =>
  value === "running" || value === "waiting" ? value : "idle";

function parseChat(raw: unknown): SharedChat | null {
  const chat = obj(raw);
  const id = int(chat?.["id"]);
  const projectId = int(chat?.["project_id"]);
  if (chat === null || id === null || projectId === null) return null;
  const threadId = text(chat["thread_id"]);
  if (threadId.length === 0) return null;
  return {
    id,
    projectId,
    source: text(chat["source"]),
    threadId,
    title: text(chat["title"]),
    status: chatStatus(chat["status"]),
    shares: arr(chat["shares"]).flatMap((entry) => {
      const share = obj(entry);
      const userId = int(share?.["user_id"]);
      const level = share?.["level"];
      return userId !== null && (level === "read" || level === "write") ? [{ userId, level }] : [];
    }),
  };
}

/** `GET projects/{id}/chats?source=` → this person's own chats (`mine`). */
export function parseMyChats(body: unknown): ReadonlyArray<SharedChat> {
  return arr(obj(body)?.["mine"]).flatMap((raw) => {
    const chat = parseChat(raw);
    return chat === null ? [] : [chat];
  });
}

/** `GET chats/inbound` → colleagues' messages waiting for this computer's chats. */
export function parseInbound(body: unknown): ReadonlyArray<InboundMessage> {
  return arr(obj(body)?.["messages"]).flatMap((raw) => {
    const message = obj(raw);
    const id = int(message?.["id"]);
    const chatId = int(message?.["chat_id"]);
    if (message === null || id === null || chatId === null) return [];
    const threadId = text(message["thread_id"]);
    const body = text(message["text"]);
    if (threadId.length === 0 || body.trim().length === 0) return [];
    return [
      {
        id,
        chatId,
        threadId,
        from: parsePerson(message["from"]) ?? { userId: 0, email: null, username: null },
        text: body,
        createdAt: text(message["created_at"]),
      },
    ];
  });
}

export function parseRequest(raw: unknown): TeamRequest | null {
  const request = obj(raw);
  const id = int(request?.["id"]);
  const projectId = int(request?.["project_id"]);
  if (request === null || id === null || projectId === null) return null;
  const kind = request["kind"];
  const status = request["status"];
  if (typeof kind !== "string" || !KINDS.has(kind)) return null;
  if (typeof status !== "string" || !STATUSES.has(status)) return null;
  const level = isLevel(request["level"]) ? request["level"] : "ask";
  return {
    id,
    rev: int(request["rev"]) ?? 0,
    projectId,
    projectName: text(request["project_name"]),
    from: parsePerson(request["from"]) ?? { userId: 0, email: null, username: null },
    to: parsePerson(request["to"]) ?? { userId: 0, email: null, username: null },
    kind: kind as TeamRequestKind,
    viaAgent: request["via_agent"] === true,
    fromChatTitle: text(request["from_chat_title"]),
    fromThread: textOrNull(request["from_thread"]),
    title: text(request["title"]),
    gist: text(request["gist"]),
    body: text(request["body"]),
    level,
    levelNow: isLevel(request["level_now"]) ? request["level_now"] : level,
    auto: request["auto"] === true,
    status: status as TeamRequestStatus,
    reason: textOrNull(request["reason"]),
    answer: textOrNull(request["answer"]),
    threadTitle: textOrNull(request["thread_title"]),
    createdAt: text(request["created_at"]),
    expiresAt: text(request["expires_at"]),
    stopRequested: request["stop_requested"] === true,
    chatId: int(request["chat_id"]),
  };
}

/** `GET requests/inbox|outgoing` → `{requests, rev}`. */
export function parseRequests(body: unknown): {
  readonly requests: ReadonlyArray<TeamRequest>;
  readonly rev: number | null;
} {
  const value = obj(body);
  return {
    requests: arr(value?.["requests"]).flatMap((raw) => {
      const request = parseRequest(raw);
      return request === null ? [] : [request];
    }),
    rev: int(value?.["rev"]),
  };
}

const levelMap = (value: unknown): Readonly<Record<string, TeamAgentLevel>> => {
  const map = obj(value);
  const out: Record<string, TeamAgentLevel> = {};
  if (map === null) return out;
  for (const [uid, level] of Object.entries(map)) if (isLevel(level)) out[uid] = level;
  return out;
};

/** `GET projects/{id}/levels` → the levels in effect, both ways. */
export function parseLevels(body: unknown): TeamLevels {
  const value = obj(body);
  return {
    effectiveIn: levelMap(value?.["effective_in"]),
    effectiveOut: levelMap(value?.["effective_out"]),
  };
}

/** `400 INVALID_FIELD {field, reason}` → "title: too_long"; else "". */
export function fieldProblem(body: unknown): string {
  const value = obj(body);
  const field = value?.["field"];
  const reason = value?.["reason"];
  if (typeof field !== "string" || field.length === 0) return "";
  return typeof reason === "string" && reason.length > 0 ? `${field}: ${reason}` : field;
}

/** The error code of a console answer (`{error: "CODE"}`), or "". */
export function errorCode(body: unknown): string {
  const code = obj(body)?.["error"];
  return typeof code === "string" ? code : "";
}

/** Codes that mean "not on for this person": every part off, quietly. */
export const OFF_CODES: ReadonlySet<string> = new Set([
  "WORK_TEAM_COLLAB_DISABLED",
  "WORK_TEAM_DISABLED",
]);
