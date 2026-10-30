/**
 * Finds messages: `search` across chats for ⌘K ("where did we discuss this"),
 * `findInThread` inside one chat for ⌘F. Both read the trigram index; without
 * it they scan, `search` only the most recent messages.
 */
import type {
  MessageId,
  OrchestrationFindInThreadInput,
  OrchestrationFindInThreadResult,
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
  OrchestrationThreadSearchMatch,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  buildThreadSearchSnippet,
  countThreadSearchOccurrences,
  longestMessageSearchToken,
  messageSearchGrader,
  messageSearchMatchExpression,
  threadSearchVisibleText,
} from "@t3tools/shared/threadSearch";
import { Context, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  backfillMessageSearch,
  countUnindexedMessages,
  messageSearchIndexExists,
} from "./messageSearchIndex.ts";

const DEFAULT_RESULT_LIMIT = 10;
// The newest hits read per query. A common word stops here instead of reading
// every message, so time stays flat as history grows.
const MESSAGE_HIT_LIMIT = 1000;
// Without the index, how many of the newest messages a search scans.
const MESSAGE_SCAN_LIMIT = 5000;
// More than a person steps through; a huge chat cannot make the answer huge.
const FIND_MAX_ENTRIES = 5000;

interface HitRow {
  readonly messageId: MessageId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface ThreadSearchShape {
  readonly search: (
    input: OrchestrationSearchThreadsInput,
  ) => Effect.Effect<OrchestrationSearchThreadsResult, SqlError>;
  readonly findInThread: (
    input: OrchestrationFindInThreadInput,
  ) => Effect.Effect<OrchestrationFindInThreadResult, SqlError>;
  /** Adds messages from before the index, in small steps. */
  readonly backfill: Effect.Effect<void, SqlError>;
}

export class ThreadSearch extends Context.Service<ThreadSearch, ThreadSearchShape>()(
  "t3/search/ThreadSearch",
) {}

/** One result per chat: its best message, then the person's own words, then the newest. */
export function pickThreadMatches(
  rows: ReadonlyArray<HitRow>,
  query: string,
  limit: number,
): OrchestrationThreadSearchMatch[] {
  const grade = messageSearchGrader(query);
  const byThread = new Map<
    string,
    { readonly row: HitRow; readonly quality: number; readonly offset: number; hits: number }
  >();
  for (const row of rows) {
    const text = threadSearchVisibleText(row.text);
    const graded = grade(text);
    if (graded === null) continue;
    const current = byThread.get(row.threadId);
    if (current === undefined) {
      byThread.set(row.threadId, { row, ...graded, hits: 1 });
      continue;
    }
    current.hits += 1;
    const better =
      graded.quality > current.quality ||
      (graded.quality === current.quality && row.role === "user" && current.row.role !== "user") ||
      (graded.quality === current.quality &&
        row.role === current.row.role &&
        row.createdAt > current.row.createdAt);
    if (better) byThread.set(row.threadId, { row, ...graded, hits: current.hits });
  }
  return [...byThread.values()]
    .toSorted(
      (left, right) =>
        right.quality - left.quality ||
        right.row.createdAt.localeCompare(left.row.createdAt) ||
        right.hits - left.hits,
    )
    .slice(0, limit)
    .map(({ row, quality, offset, hits }) => ({
      threadId: row.threadId,
      projectId: row.projectId,
      messageId: row.messageId,
      source: row.role,
      snippet: buildThreadSearchSnippet(threadSearchVisibleText(row.text), offset),
      messageCreatedAt: row.createdAt,
      quality,
      hits,
    }));
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let indexing = false;

  // Archived chats still open, so they count; deleted ones do not.
  const visible = sql`
    threads.deleted_at IS NULL
    AND projects.deleted_at IS NULL
    AND messages.role IN ('user', 'assistant')
  `;

  const indexedHits = (match: string) => sql<HitRow>`
    SELECT
      messages.message_id AS "messageId",
      messages.thread_id AS "threadId",
      threads.project_id AS "projectId",
      messages.role AS role,
      messages.text AS text,
      messages.created_at AS "createdAt"
    FROM message_search
    INNER JOIN message_search_docs AS docs ON docs.doc_id = message_search.rowid
    INNER JOIN projection_thread_messages AS messages ON messages.message_id = docs.message_id
    INNER JOIN projection_threads AS threads ON threads.thread_id = messages.thread_id
    INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
    WHERE message_search MATCH ${match}
      AND ${visible}
    ORDER BY message_search.rowid DESC
    LIMIT ${MESSAGE_HIT_LIMIT}
  `;

  const scannedHits = (needle: string) => sql<HitRow>`
    SELECT
      messages.message_id AS "messageId",
      messages.thread_id AS "threadId",
      threads.project_id AS "projectId",
      messages.role AS role,
      messages.text AS text,
      messages.created_at AS "createdAt"
    FROM (
      SELECT * FROM projection_thread_messages ORDER BY rowid DESC LIMIT ${MESSAGE_SCAN_LIMIT}
    ) AS messages
    INNER JOIN projection_threads AS threads ON threads.thread_id = messages.thread_id
    INNER JOIN projection_projects AS projects ON projects.project_id = threads.project_id
    WHERE instr(lower(messages.text), ${needle}) > 0
      AND ${visible}
    LIMIT ${MESSAGE_HIT_LIMIT}
  `;

  const search: ThreadSearchShape["search"] = (input) =>
    Effect.gen(function* () {
      const limit = input.limit ?? DEFAULT_RESULT_LIMIT;
      const match = messageSearchMatchExpression(input.query);
      if (match === null) return { matches: [], indexing: false };
      const hasIndex = yield* messageSearchIndexExists(sql);
      // The scan's `lower` folds ASCII only, so it looks for the longest token as typed.
      const rows = hasIndex
        ? yield* indexedHits(match)
        : yield* scannedHits(longestMessageSearchToken(input.query));
      return {
        matches: pickThreadMatches(rows, input.query, limit),
        indexing,
      };
    }).pipe(Effect.withSpan("ThreadSearch.search"));

  const findInThread: ThreadSearchShape["findInThread"] = (input) =>
    Effect.gen(function* () {
      const match = input.query.length >= 3 ? quotedPhrase(input.query) : null;
      const hasIndex = match !== null && (yield* messageSearchIndexExists(sql));
      // Streaming messages and ones the backfill has not reached are not in
      // the index yet, so they are always read.
      const indexed = hasIndex
        ? sql`
            AND (
              messages.is_streaming = 1
              OR docs.doc_id IS NULL
              OR docs.doc_id IN (
                SELECT rowid FROM message_search WHERE message_search MATCH ${match}
              )
            )
          `
        : sql.literal("");
      const joined = hasIndex
        ? sql.literal(
            "LEFT JOIN message_search_docs AS docs ON docs.message_id = messages.message_id",
          )
        : sql.literal("");
      const rows = yield* sql<{ readonly messageId: MessageId; readonly text: string }>`
        SELECT messages.message_id AS "messageId", messages.text AS text
        FROM projection_thread_messages AS messages
        ${joined}
        WHERE messages.thread_id = ${input.threadId}
          AND messages.role IN ('user', 'assistant')
          ${indexed}
        ORDER BY messages.created_at ASC, messages.message_id ASC
      `;
      const entries: Array<OrchestrationFindInThreadResult["entries"][number]> = [];
      let totalMatches = 0;
      for (const row of rows) {
        const count = countThreadSearchOccurrences(threadSearchVisibleText(row.text), input.query);
        if (count === 0) continue;
        entries.push({ messageId: row.messageId, count, startIndex: totalMatches });
        totalMatches += count;
        if (entries.length >= FIND_MAX_ENTRIES) break;
      }
      return { totalMatches, entries };
    }).pipe(Effect.withSpan("ThreadSearch.findInThread"));

  const backfill: ThreadSearchShape["backfill"] = Effect.gen(function* () {
    if (!(yield* messageSearchIndexExists(sql))) return;
    if ((yield* countUnindexedMessages(sql)) === 0) return;
    indexing = true;
    yield* backfillMessageSearch(sql).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          indexing = false;
        }),
      ),
    );
  });

  return ThreadSearch.of({ search, findInThread, backfill });
});

// A whole query as one phrase: ⌘F looks for what was typed, spaces included.
function quotedPhrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"`;
}

export const ThreadSearchLive = Layer.effect(ThreadSearch, make);
