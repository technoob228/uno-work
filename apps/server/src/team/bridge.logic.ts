/**
 * T51 (b)(c)(d): the rules of the team bridge, without I/O (bridge.ts does
 * the calls):
 *
 * - a colleague's `session` request becomes a T50 host record with `team`
 *   on the computer that has the project's folder (the first to claim it);
 * - how a record goes is told to the cloud once per step (started, then
 *   done / stopped; or declined, expired, refused);
 * - a `question` is answered by a read-only chat here on its own only at
 *   "Answer questions" or higher (and (c) on), else when the person presses
 *   "Let my agent answer";
 * - "Do tasks" starts a session without a button only when (d) is on, the
 *   request says `auto`, and the level read again just before says so.
 *
 * @module team/bridge.logic
 */
import {
  CHAT_REQUEST_BRIEF_MAX_CHARS,
  CHAT_REQUEST_GIST_MAX_CHARS,
  CHAT_REQUEST_TITLE_MAX_CHARS,
  type ChatRequestFile,
  type ChatRequestTeam,
  type TeamParts,
} from "@t3tools/contracts";

import { GUARDED_PROVIDER, teamRecordId, type HostRecord } from "../chatRequests/hostLogic.ts";
import type { StatusInput } from "./teamCloud.ts";
import { levelAtLeast, personName, type TeamLevels, type TeamRequest } from "./teamCloud.logic.ts";

/** A colleague's agent's answer, at most (the cloud's limit is wider). */
export const ANSWER_MAX_CHARS = 8_000;

const cut = (text: string, max: number, fallback: string) => {
  const flat = text.trim();
  if (flat.length === 0) return fallback;
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** The host's record of a colleague's session request, in its project's folder here. */
export function teamFileOf(
  request: TeamRequest,
  folder: string,
): ChatRequestFile & { readonly team: ChatRequestTeam } {
  const fromName = personName(request.from);
  const title = cut(request.title, CHAT_REQUEST_TITLE_MAX_CHARS, `A task from ${fromName}`);
  const team: ChatRequestTeam = {
    requestId: request.id,
    projectId: request.projectId,
    projectName: cut(request.projectName, 200, "a project"),
    fromUserId: request.from.userId,
    fromName: cut(fromName, 200, "A colleague"),
    viaAgent: request.viaAgent,
    level: request.levelNow,
    auto: request.auto && request.levelNow === "tasks",
  };
  return {
    v: 1,
    id: teamRecordId(request.id),
    createdAt: request.createdAt || new Date().toISOString(),
    expiresAt: request.expiresAt || "",
    from: {
      computerName: cut(`${fromName}'s computer`, 200, "a colleague's computer"),
      boxId: null,
      threadId: cut(request.fromThread ?? "", 200, `team-request-${request.id}`),
      threadTitle: cut(request.fromChatTitle, 200, ""),
    },
    cwd: folder,
    provider: GUARDED_PROVIDER,
    title,
    gist: cut(
      request.gist,
      CHAT_REQUEST_GIST_MAX_CHARS,
      title.slice(0, CHAT_REQUEST_GIST_MAX_CHARS),
    ),
    brief: cut(request.body, CHAT_REQUEST_BRIEF_MAX_CHARS, title),
    team,
  };
}

/** What the cloud hears next of a record: `key` once per step, in order. */
export interface Report {
  readonly key: string;
  readonly input: StatusInput;
}

/** The steps a record has reached, in the order the cloud hears them. */
export function reportsOf(record: HostRecord): ReadonlyArray<Report> {
  switch (record.status) {
    case "queued":
    case "waiting":
      return [];
    case "declined":
    case "expired":
    case "refused":
      return [
        {
          key: record.status,
          input: { status: record.status, ...(record.reason ? { reason: record.reason } : {}) },
        },
      ];
    case "started": {
      const started: Report = {
        key: "started",
        input: {
          status: "started",
          ...(record.threadTitle ? { threadTitle: record.threadTitle } : {}),
        },
      };
      switch (record.threadState) {
        case "done":
          return [
            started,
            {
              key: "done",
              input: {
                status: "done",
                ...(record.lastMessage ? { answer: record.lastMessage } : {}),
              },
            },
          ];
        case "failed":
          return [
            started,
            { key: "done", input: { status: "done", reason: "The chat stopped with an error." } },
          ];
        case "stopped":
          return [started, { key: "stopped", input: { status: "stopped" } }];
        default:
          return [started];
      }
    }
  }
}

/** The reports not told yet (`told`: the keys the cloud already has). */
export function dueReports(record: HostRecord, told: ReadonlyArray<string>): ReadonlyArray<Report> {
  return reportsOf(record).filter((report) => !told.includes(report.key));
}

/** A colleague's agent's question answered here on its own (level Answer questions or higher). */
export function answersOnItsOwn(request: TeamRequest, parts: TeamParts): boolean {
  return (
    request.kind === "question" &&
    request.status === "waiting" &&
    parts.agents &&
    levelAtLeast(request.levelNow, "answer")
  );
}

/** "Do tasks": started without a button. The level read just now must still say so. */
export function startsOnItsOwn(
  request: TeamRequest,
  parts: TeamParts,
  levels: TeamLevels | null,
): boolean {
  if (request.kind !== "session" || !request.auto || !parts.tasks) return false;
  if (request.levelNow !== "tasks") return false;
  return levels?.effectiveIn[String(request.from.userId)] === "tasks";
}

/** A read-only chat's state → what the cloud hears; null: still working. */
export function answerStep(
  follow: { readonly state: string; readonly lastMessage: string | null } | null,
): StatusInput | null {
  if (follow === null) return { status: "refused", reason: "The chat that answered is gone." };
  if (follow.state === "running" || follow.state === "waiting-for-you") return null;
  if (follow.state === "failed") {
    return { status: "refused", reason: "The chat that answered stopped with an error." };
  }
  if (follow.state === "stopped") {
    return { status: "stopped", reason: "The person here stopped the chat that answered." };
  }
  const answer = follow.lastMessage?.trim() ?? "";
  if (answer.length === 0) {
    return follow.state === "done" ? { status: "refused", reason: "No answer came." } : null;
  }
  return { status: "answered", answer: cut(answer, ANSWER_MAX_CHARS, answer) };
}

/** The cloud's word on a request that waits here: over? */
export function retiredBy(request: TeamRequest): {
  readonly status: "expired" | "refused";
  readonly reason: string;
} | null {
  if (request.status === "cancelled") {
    return { status: "refused", reason: request.reason ?? "The colleague cancelled it." };
  }
  if (request.status === "expired") {
    return { status: "expired", reason: request.reason ?? "Nobody answered it within its time." };
  }
  if (request.status === "declined" || request.status === "refused") {
    return { status: "refused", reason: request.reason ?? "It was decided elsewhere." };
  }
  return null;
}
