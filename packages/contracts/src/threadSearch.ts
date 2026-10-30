import { Schema } from "effect";

import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const THREAD_SEARCH_QUERY_MAX_LENGTH = 200;
/** Snippets and the longest line a result row can show. */
export const THREAD_SEARCH_SNIPPET_MAX_LENGTH = 240;

export const OrchestrationThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

// The server's SQLite client is synchronous and single-connection: both the
// query and the answer are bounded, so a search cannot hold it for long.
export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(
    Schema.isMinLength(2),
    Schema.isMaxLength(THREAD_SEARCH_QUERY_MAX_LENGTH),
  ),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  messageId: MessageId,
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String,
  messageCreatedAt: IsoDateTime,
  /** 1 for whole words, 0.8 for word starts, 0.3 inside words; +0.25 written together. */
  quality: Schema.Number,
  /** How many of the chat's recent messages match. */
  hits: Schema.Int,
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
  /** Older messages are still being indexed, so an empty answer is not final. */
  indexing: Schema.Boolean,
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export const OrchestrationFindInThreadInput = Schema.Struct({
  threadId: ThreadId,
  query: TrimmedString.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(THREAD_SEARCH_QUERY_MAX_LENGTH),
  ),
});
export type OrchestrationFindInThreadInput = typeof OrchestrationFindInThreadInput.Type;

export const OrchestrationThreadFindEntry = Schema.Struct({
  messageId: MessageId,
  /** Matches in this message. */
  count: Schema.Int,
  /** Matches in the messages before this one. */
  startIndex: Schema.Int,
});
export type OrchestrationThreadFindEntry = typeof OrchestrationThreadFindEntry.Type;

/** Messages in order, those with matches only. */
export const OrchestrationFindInThreadResult = Schema.Struct({
  totalMatches: Schema.Int,
  entries: Schema.Array(OrchestrationThreadFindEntry),
});
export type OrchestrationFindInThreadResult = typeof OrchestrationFindInThreadResult.Type;

export class OrchestrationSearchThreadsError extends Schema.TaggedErrorClass<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class OrchestrationFindInThreadError extends Schema.TaggedErrorClass<OrchestrationFindInThreadError>()(
  "OrchestrationFindInThreadError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
