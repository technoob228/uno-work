/**
 * The T51 routes this daemon calls in the Uno cloud (PLAN.md "API", the "D"
 * routes only: a machine's token may call them; the person's own decisions
 * are "C" routes, made from the interface with their sign-in).
 *
 * Calls go with this computer's credential (`consoleToken`: the machine
 * token on a cloud computer, the account key on a laptop). Bodies are never
 * logged: they carry colleagues' words.
 *
 * What is on (`GET collab`) is cached like the assistants flag
 * (assistantsFeature.ts): 10 minutes when something is on, 5 when all is
 * off, 1 after a failure. A failure, no credential, or the server's "off"
 * codes read as all off — nothing starts by mistake.
 *
 * @module team/teamCloud
 */
import type { TeamChatStatus, TeamParts } from "@t3tools/contracts";

import { consoleRequest, type ConsoleReply } from "../unoWork/consoleClient.ts";
import {
  errorCode,
  fieldProblem,
  NO_PARTS,
  OFF_CODES,
  parseInbound,
  parseLevels,
  parseMembers,
  parseMyChats,
  parseParts,
  parseProjects,
  parseRequest,
  parseRequests,
  type InboundMessage,
  type SharedChat,
  type TeamLevels,
  type TeamMember,
  type TeamProject,
  type TeamRequest,
  type TeamRequestStatus,
} from "./teamCloud.logic.ts";

const ROOT = "/api/v1/work/team";

export const PARTS_ON_TTL_MS = 10 * 60_000;
export const PARTS_OFF_TTL_MS = 5 * 60_000;
export const PARTS_FAILED_TTL_MS = 60_000;
/** A long poll waits this long at most (the server caps `wait` at 25). */
export const LONG_POLL_WAIT_S = 25;

export class TeamCloudError extends Error {
  readonly status: number;
  readonly code: string;
  /** `INVALID_FIELD`: which field and why ("title: too_long"), else "". */
  readonly field: string;
  constructor(status: number, code: string, message: string, field = "") {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
  /** The part is off for this person (or the other one): stop quietly. */
  get off(): boolean {
    return OFF_CODES.has(this.code) || this.status === 401;
  }
}

/** A sentence for the person and the logs; never the body. */
function problem(status: number, code: string): string {
  if (status === 0) return "Couldn't reach the Uno cloud.";
  if (status === 401) return "Uno didn't accept this computer's key. Sign in to Uno again.";
  if (OFF_CODES.has(code)) return "Working with the team isn't on for this account.";
  if (code === "PERSON_NOT_ENABLED") return "Working with the team isn't on for that person yet.";
  if (code === "NOT_SHARED") return "The chat isn't shared with anyone any more.";
  if (code === "SOURCE_MISMATCH") return "That chat is mirrored from another computer.";
  if (code === "CHAT_IN_OTHER_PROJECT") return "That chat is shared in another project.";
  if (code === "NOT_CLAIMER") return "Another computer of this person took that request.";
  if (code === "REQUEST_NOT_WAITING") return "That request isn't waiting any more.";
  if (code === "CANNOT_TARGET_SELF") return "That's the person themself.";
  if (code === "INVALID_FIELD") return "The Uno cloud didn't accept a field.";
  if (code === "BODY_TOO_LARGE" || status === 413) return "It is too long for the Uno cloud.";
  if (code === "CLAIMED") return "Another computer took it first.";
  if (code === "LEVEL_OFF") return "Their agents can't reach this person in this project.";
  if (code === "TOO_MANY_ROUNDS") return "Too many rounds between the agents.";
  if (code === "TOO_MANY_SESSIONS") return "That person already has 2 sessions from colleagues.";
  if (status === 429) return "Too many requests: 20 an hour from one person.";
  if (status === 403) return "This computer's key isn't allowed to do that.";
  if (status === 404) return code ? `Not found (${code}).` : "Not found.";
  return `The Uno cloud answered ${status}${code ? ` (${code})` : ""}.`;
}

export interface TeamCloudAccess {
  readonly baseUrl: () => string;
  /** Read each time: the console may link the computer after start. "" = none. */
  readonly token: () => Promise<string>;
  readonly fetchImpl?: typeof fetch;
}

export interface PostedEvent {
  readonly message_id: string;
  readonly role: "user" | "assistant" | "activity";
  readonly text: string;
  readonly at: string;
}

export interface AgentRequestInput {
  readonly to: number;
  readonly kind: "message" | "question" | "session";
  readonly title: string;
  readonly gist: string;
  readonly body: string;
  readonly fromSource: string;
  readonly fromThread: string;
  readonly fromChatTitle: string;
}

export interface StatusInput {
  readonly status: Exclude<TeamRequestStatus, "waiting" | "read" | "cancelled">;
  readonly reason?: string;
  readonly threadTitle?: string;
  readonly answer?: string;
  /** Who decided (started, declined, answered): the person here, in Telegram, or the level. */
  readonly decidedVia?: "here" | "telegram" | "auto";
}

export function makeTeamCloud(access: TeamCloudAccess) {
  const call = async (
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const token = await access.token();
    if (token.length === 0) {
      throw new TeamCloudError(401, "", "This computer isn't signed in to Uno.");
    }
    let reply: ConsoleReply;
    try {
      reply = await consoleRequest({
        method,
        path: `${ROOT}${path}`,
        ...(body !== undefined ? { body } : {}),
        baseUrl: access.baseUrl(),
        token,
        ...(access.fetchImpl ? { fetchImpl: access.fetchImpl } : {}),
      });
    } catch {
      throw new TeamCloudError(0, "", problem(0, ""));
    }
    if (reply.status < 200 || reply.status >= 300) {
      const code = errorCode(reply.body);
      const field = code === "INVALID_FIELD" ? fieldProblem(reply.body) : "";
      throw new TeamCloudError(
        reply.status,
        code,
        field ? `${problem(reply.status, code)} (${field})` : problem(reply.status, code),
        field,
      );
    }
    return reply.body;
  };
  const q = (params: Record<string, string | number | undefined>) => {
    const entries = Object.entries(params).filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    );
    return entries.length === 0
      ? ""
      : `?${entries.map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join("&")}`;
  };

  return {
    collab: async (): Promise<TeamParts> => parseParts(await call("GET", "/collab")),
    projects: async (): Promise<ReadonlyArray<TeamProject>> =>
      parseProjects(await call("GET", "/projects")),
    members: async (projectId: number): Promise<ReadonlyArray<TeamMember>> =>
      parseMembers(await call("GET", `/projects/${projectId}`)),
    myChats: async (projectId: number, source: string): Promise<ReadonlyArray<SharedChat>> =>
      parseMyChats(await call("GET", `/projects/${projectId}/chats${q({ source })}`)),
    postEvents: async (
      chatId: number,
      input: {
        readonly source: string;
        readonly title?: string;
        readonly status?: TeamChatStatus;
        readonly events: ReadonlyArray<PostedEvent>;
      },
    ): Promise<void> => {
      await call("POST", `/chats/${chatId}/events`, input);
    },
    inbound: async (source: string, wait: number): Promise<ReadonlyArray<InboundMessage>> =>
      parseInbound(await call("GET", `/chats/inbound${q({ source, wait })}`)),
    ackInbound: async (
      id: number,
      status: "delivered" | "failed",
      reason?: string,
    ): Promise<void> => {
      await call("POST", `/chats/inbound/${id}/ack`, {
        status,
        ...(reason !== undefined ? { reason } : {}),
      });
    },
    inbox: async (afterRev: number, wait: number) =>
      parseRequests(await call("GET", `/requests/inbox${q({ after_rev: afterRev, wait })}`)),
    outgoing: async (source: string, afterRev: number, wait: number) =>
      parseRequests(
        await call("GET", `/requests/outgoing${q({ source, after_rev: afterRev, wait })}`),
      ),
    /** True: this computer took it; false: another one was first (`409 CLAIMED`). */
    claim: async (requestId: number, source: string): Promise<boolean> => {
      try {
        await call("POST", `/requests/${requestId}/claim`, { source });
        return true;
      } catch (error) {
        if (error instanceof TeamCloudError && error.code === "CLAIMED") return false;
        throw error;
      }
    },
    status: async (requestId: number, source: string, input: StatusInput): Promise<void> => {
      await call("POST", `/requests/${requestId}/status`, {
        source,
        status: input.status,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.threadTitle !== undefined ? { thread_title: input.threadTitle } : {}),
        ...(input.answer !== undefined ? { answer: input.answer } : {}),
        ...(input.decidedVia !== undefined ? { decided_via: input.decidedVia } : {}),
      });
    },
    /** True only for the first computer of the account that asks: it sends the Telegram copy. */
    telegram: async (requestId: number, source: string): Promise<boolean> => {
      const body = await call("POST", `/requests/${requestId}/telegram`, { source });
      return (body as { send?: unknown } | null)?.send === true;
    },
    agentRequest: async (projectId: number, input: AgentRequestInput): Promise<TeamRequest> => {
      const body = await call("POST", `/projects/${projectId}/agent-requests`, {
        to: input.to,
        kind: input.kind,
        title: input.title,
        gist: input.gist,
        body: input.body,
        from_source: input.fromSource,
        from_thread: input.fromThread,
        from_chat_title: input.fromChatTitle,
      });
      const request = parseRequest((body as { request?: unknown } | null)?.request);
      if (request === null) throw new TeamCloudError(502, "", "The Uno cloud's answer was empty.");
      return request;
    },
    levels: async (projectId: number): Promise<TeamLevels> =>
      parseLevels(await call("GET", `/projects/${projectId}/levels`)),
  };
}

export type TeamCloud = ReturnType<typeof makeTeamCloud>;

/** What is on, cached (see the module note). */
export function makePartsCache(input: {
  readonly fetch: () => Promise<TeamParts>;
  readonly now?: () => number;
}) {
  const now = input.now ?? Date.now;
  let cached: { readonly parts: TeamParts; readonly until: number; readonly at: number } | null =
    null;
  let inFlight: Promise<TeamParts> | null = null;
  let lastError: string | null = null;
  const load = async (): Promise<TeamParts> => {
    let parts = NO_PARTS;
    let ttl = PARTS_FAILED_TTL_MS;
    try {
      parts = await input.fetch();
      ttl =
        parts.share || parts.requests || parts.agents || parts.tasks
          ? PARTS_ON_TTL_MS
          : PARTS_OFF_TTL_MS;
      lastError = null;
    } catch (error) {
      if (error instanceof TeamCloudError && error.off) {
        ttl = PARTS_OFF_TTL_MS;
        lastError = null;
      } else {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    cached = { parts, until: now() + ttl, at: now() };
    return parts;
  };
  return {
    get: (): Promise<TeamParts> => {
      if (cached !== null && cached.until > now()) return Promise.resolve(cached.parts);
      inFlight ??= load().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    /** What is known now, without asking. */
    peek: (): TeamParts => cached?.parts ?? NO_PARTS,
    checkedAt: (): number | null => cached?.at ?? null,
    lastError: (): string | null => lastError,
    /** The server said a part is off: ask again later, all off until then. */
    markOff: () => {
      cached = { parts: NO_PARTS, until: now() + PARTS_OFF_TTL_MS, at: now() };
    },
    invalidate: () => {
      cached = null;
    },
  };
}

export type PartsCache = ReturnType<typeof makePartsCache>;
