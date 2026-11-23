/**
 * T51 "Team in a project" — what Uno Work's daemon on this computer does for
 * the people of a project (PLAN.md in reports/day_2026-11-20/team-collab):
 *
 * - mirrors the chats the person shared into the Uno cloud (the colleague
 *   reads them there, with their own sign-in);
 * - delivers a colleague's message into a shared chat as outside text (T49);
 * - takes requests from colleagues' agents: a session here (the T50 host
 *   with `team`, see chatRequests.ts), a question answered by a read-only
 *   chat, and tells the asking chat how its own requests went.
 *
 * The person's own decisions (share, levels, answer, allow writing) go from
 * the interface with their sign-in, never through here: the daemon only has
 * this computer's key. These are the methods the interface asks the daemon.
 *
 * @module team
 */
import { Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** What `GET /api/v1/work/team/collab` says is on for this person. */
export const TeamParts = Schema.Struct({
  /** (a) shared chats, read and write. */
  share: Schema.Boolean,
  /** (b) requests between people, "a session on your computer". */
  requests: Schema.Boolean,
  /** (c) levels up to "Answer questions", the journal. */
  agents: Schema.Boolean,
  /** (d) "Do tasks". */
  tasks: Schema.Boolean,
});
export type TeamParts = typeof TeamParts.Type;

export const TeamChatStatus = Schema.Literals(["idle", "running", "waiting"]);
export type TeamChatStatus = typeof TeamChatStatus.Type;

/** A chat of this computer the person shared: what the mirror sends of it. */
export const TeamMirroredChat = Schema.Struct({
  /** `work_shared_chats.id`. */
  chatId: Schema.Number,
  threadId: Schema.String,
  title: Schema.String,
  projectId: Schema.Number,
  projectName: Schema.String,
  /** How many people it is shared with now. */
  sharedWith: NonNegativeInt,
  status: TeamChatStatus,
  /** Events waiting to go (a failed send keeps them). */
  pending: NonNegativeInt,
  lastSentAt: Schema.NullOr(Schema.String),
  /** The last send failed: why, in a sentence. */
  error: Schema.NullOr(Schema.String),
});
export type TeamMirroredChat = typeof TeamMirroredChat.Type;

/** A question a colleague's agent asked, answered here by a read-only chat. */
export const TeamAnswering = Schema.Struct({
  requestId: Schema.Number,
  threadId: Schema.String,
  projectName: Schema.String,
  fromName: Schema.String,
  startedAt: Schema.String,
});
export type TeamAnswering = typeof TeamAnswering.Type;

export const TeamErrorPart = Schema.Literals([
  "collab",
  "mirror",
  "inbound",
  "bridge",
  "outgoing",
  "telegram",
]);
export type TeamErrorPart = typeof TeamErrorPart.Type;

export const TeamLastError = Schema.Struct({
  at: Schema.String,
  part: TeamErrorPart,
  message: Schema.String,
});
export type TeamLastError = typeof TeamLastError.Type;

/** `team.state`: what this computer does for the team now. */
export const TeamState = Schema.Struct({
  /** Any part is on for this person, and this computer can reach the Uno cloud. */
  enabled: Schema.Boolean,
  parts: TeamParts,
  /** This Uno Work's id as the cloud knows it (`source` of its chats). */
  source: Schema.String,
  mirrored: Schema.Array(TeamMirroredChat),
  answering: Schema.Array(TeamAnswering),
  /** Sessions from colleagues working here now, and how many may at once. */
  colleagueSessions: NonNegativeInt,
  colleagueSessionsLimit: NonNegativeInt,
  /** The last few problems, newest first. */
  errors: Schema.Array(TeamLastError),
  /** When it last asked the cloud what is on. */
  checkedAt: Schema.NullOr(Schema.String),
});
export type TeamState = typeof TeamState.Type;

export const TeamLetAgentAnswerInput = Schema.Struct({
  /** `work_team_requests.id` of a `question`. */
  requestId: Schema.Number,
});
export type TeamLetAgentAnswerInput = typeof TeamLetAgentAnswerInput.Type;

export const TeamLetAgentAnswerResult = Schema.Struct({
  /** The read-only chat that answers it here. */
  threadId: Schema.String,
  state: TeamState,
});
export type TeamLetAgentAnswerResult = typeof TeamLetAgentAnswerResult.Type;

export class TeamError extends Schema.TaggedErrorClass<TeamError>()("TeamError", {
  message: TrimmedNonEmptyString,
}) {}
