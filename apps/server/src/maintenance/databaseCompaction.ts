/**
 * Keeps the database from growing without end.
 *
 * Most of a big `state.sqlite` is the event log, and most of that is history
 * the chats no longer read: a chat opens from the projections. Two things go,
 * in small transactions, so a crash can only stop the work, never half-do it:
 *
 * - An assistant message is thousands of `thread.message-sent` events, one per
 *   delta, and the final one has no text. They fold into one event holding
 *   the whole text, so replaying the log still gives the same message. Nothing
 *   is lost even if every projection were rebuilt from scratch.
 * - Old `thread.activity-appended` events go when their row is in
 *   `projection_thread_activities`: what the chat shows stays. A projector
 *   added later that replays from zero would not see them.
 *
 * Only events no projector still needs, past the newest ones: clients resume
 * from recent events, and anything older than `SHELL_RESUME_MAX_EVENTS` gets a
 * snapshot anyway. Freed pages go back to SQLite, so the file stops growing;
 * it shrinks with `doctor`, which needs the app closed for its VACUUM.
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** The newest events are never touched, whatever their age. */
export const COMPACTION_KEEP_RECENT_EVENTS = 200_000;
export const COMPACTION_KEEP_MESSAGE_EVENTS_DAYS = 7;
export const COMPACTION_KEEP_ACTIVITY_EVENTS_DAYS = 30;

const SCAN_PAGE_EVENTS = 5_000;
const FOLD_BATCH_EVENTS = 2_000;
const PRUNE_BATCH_EVENTS = 1_000;
const DAY_MS = 86_400_000;

const ACTIVITIES_CURSOR_KEY = "activities";
const threadCursorKey = (threadId: string) => `thread:${threadId}`;

export interface MessageEvent {
  readonly sequence: number;
  readonly payload: Record<string, unknown>;
}

export interface MessageFold {
  readonly keepSequence: number;
  readonly payload: Record<string, unknown>;
  readonly removeSequences: ReadonlyArray<number>;
}

/**
 * One event that replays to the same message as `events` (ProjectionPipeline's
 * `applyThreadMessagesProjection`, and `coalesceOrchestrationMessageDeltas` for
 * clients). The last event stays, so whatever came after it still comes after.
 * What the chat shows wins over the deltas: it has secrets masked across them.
 * Null when there is nothing to fold, or text would be lost.
 */
export function foldMessageEvents(
  events: ReadonlyArray<MessageEvent>,
  projected: { readonly text: string } | null,
): MessageFold | null {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last || events.length < 2) return null;

  let text = "";
  let attachments: unknown;
  let sentByThreadId: unknown;
  for (const [index, { payload }] of events.entries()) {
    const delta = typeof payload.text === "string" ? payload.text : "";
    if (index === 0) text = delta;
    else if (payload.streaming === true) text += delta;
    else if (delta.length > 0) text = delta;
    attachments = payload.attachments ?? attachments;
    sentByThreadId = payload.sentByThreadId ?? sentByThreadId;
  }
  // A run that does not reach the message's end is only part of its text.
  const finalText = last.payload.streaming === false ? (projected?.text ?? text) : text;
  if (finalText.length === 0 && events.some(({ payload }) => payload.text !== "")) return null;

  return {
    keepSequence: last.sequence,
    payload: {
      ...last.payload,
      text: finalText,
      createdAt: first.payload.createdAt,
      ...(attachments !== undefined ? { attachments } : {}),
      ...(sentByThreadId !== undefined ? { sentByThreadId } : {}),
    },
    removeSequences: events.slice(0, -1).map(({ sequence }) => sequence),
  };
}

export interface CompactionOptions {
  readonly now: number;
  /** Tests: how many of the newest events stay whatever their age. */
  readonly keepRecentEvents?: number;
  /** Runs between batches: the server pauses so chats keep flowing. */
  readonly pause: Effect.Effect<void>;
}

export interface CompactionResult {
  readonly foldedMessages: number;
  readonly removedMessageEvents: number;
  readonly removedActivityEvents: number;
  readonly removedReceipts: number;
}

const readCursor = (sql: SqlClient.SqlClient, key: string) =>
  sql<{ readonly value: number }>`
    SELECT value FROM database_compaction_state WHERE key = ${key}
  `.pipe(Effect.map((rows) => rows[0]?.value ?? 0));

const writeCursor = (sql: SqlClient.SqlClient, key: string, value: number) => sql`
  INSERT INTO database_compaction_state (key, value) VALUES (${key}, ${value})
  ON CONFLICT (key) DO UPDATE SET value = excluded.value
`;

/** The newest event at or before `iso`. The log is in time order, near enough to search it. */
const sequenceBefore = (
  sql: SqlClient.SqlClient,
  iso: string,
  bounds: { readonly min: number; readonly max: number },
) =>
  Effect.gen(function* () {
    let low = bounds.min;
    let high = bounds.max;
    let found = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const rows = yield* sql<{ readonly sequence: number; readonly occurredAt: string }>`
        SELECT sequence, occurred_at AS "occurredAt" FROM orchestration_events
        WHERE sequence >= ${middle}
        ORDER BY sequence ASC
        LIMIT 1
      `;
      const row = rows[0];
      if (!row || row.sequence > high) {
        high = middle - 1;
      } else if (row.occurredAt <= iso) {
        found = row.sequence;
        low = row.sequence + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  });

export interface CompactionWatermarks {
  readonly messages: number;
  readonly activities: number;
}

/** How far each kind of work may go; 0 when it may not start. */
export const readCompactionWatermarks = Effect.fn("DatabaseCompaction.watermarks")(function* (
  sql: SqlClient.SqlClient,
  now: number,
  projectorCount: number,
  keepRecentEvents = COMPACTION_KEEP_RECENT_EVENTS,
) {
  const none: CompactionWatermarks = { messages: 0, activities: 0 };
  // Two statements: asking for both in one makes SQLite read the whole table.
  const first = yield* sql<{ readonly value: number | null }>`
    SELECT MIN(sequence) AS value FROM orchestration_events
  `;
  const last = yield* sql<{ readonly value: number | null }>`
    SELECT MAX(sequence) AS value FROM orchestration_events
  `;
  const min = first[0]?.value ?? null;
  const max = last[0]?.value ?? null;
  if (min === null || max === null) return none;
  const projectors = yield* sql<{ readonly projectors: number; readonly applied: number | null }>`
    SELECT COUNT(*) AS projectors, MIN(last_applied_sequence) AS applied FROM projection_state
  `;
  // A projector that has not run yet replays from zero: nothing may go.
  if ((projectors[0]?.projectors ?? 0) < projectorCount) return none;
  const applied = projectors[0]?.applied ?? 0;
  const newest = Math.min(max - keepRecentEvents, applied);
  if (newest < min) return none;
  const beforeDays = (days: number) =>
    sequenceBefore(sql, new Date(now - days * DAY_MS).toISOString(), { min, max: newest });
  return {
    messages: yield* beforeDays(COMPACTION_KEEP_MESSAGE_EVENTS_DAYS),
    activities: yield* beforeDays(COMPACTION_KEEP_ACTIVITY_EVENTS_DAYS),
  };
});

interface MessagePlan {
  readonly sequences: number[];
  lastStreaming: boolean;
}

/** One chat's messages up to `watermark`, folded in small transactions. */
export const compactThreadMessages = Effect.fn("DatabaseCompaction.thread")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
  watermark: number,
  options: CompactionOptions,
) {
  const key = threadCursorKey(threadId);
  const from = yield* readCursor(sql, key);
  const totals = { foldedMessages: 0, removedMessageEvents: 0, removedReceipts: 0 };
  if (from >= watermark) return totals;

  const plans = new Map<string, MessagePlan>();
  let cursor = from;
  while (true) {
    const rows = yield* sql<{
      readonly sequence: number;
      readonly messageId: string | null;
      readonly streaming: number | null;
    }>`
      SELECT
        sequence,
        json_extract(payload_json, '$.messageId') AS "messageId",
        json_extract(payload_json, '$.streaming') AS streaming
      FROM orchestration_events
      WHERE aggregate_kind = 'thread'
        AND stream_id = ${threadId}
        AND event_type = 'thread.message-sent'
        AND sequence > ${cursor}
        AND sequence <= ${watermark}
      ORDER BY sequence ASC
      LIMIT ${SCAN_PAGE_EVENTS}
    `;
    for (const row of rows) {
      if (row.messageId === null) continue;
      const plan = plans.get(row.messageId) ?? { sequences: [], lastStreaming: false };
      plan.sequences.push(row.sequence);
      plan.lastStreaming = row.streaming === 1;
      plans.set(row.messageId, plan);
    }
    const last = rows.at(-1);
    if (!last || rows.length < SCAN_PAGE_EVENTS) break;
    cursor = last.sequence;
    yield* options.pause;
  }

  // The chat's last message may still be running: it waits for a later pass.
  const lastMessageId = [...plans.keys()].at(-1);
  const waiting = lastMessageId !== undefined && plans.get(lastMessageId)?.lastStreaming === true;
  const heldFrom = waiting ? (plans.get(lastMessageId)?.sequences[0] ?? null) : null;
  if (waiting) plans.delete(lastMessageId);
  const work = [...plans.entries()].filter(([, plan]) => plan.sequences.length > 1);

  let index = 0;
  while (index < work.length) {
    const batch: Array<(typeof work)[number]> = [];
    let events = 0;
    while (index < work.length && (batch.length === 0 || events < FOLD_BATCH_EVENTS)) {
      const entry = work[index];
      if (!entry) break;
      batch.push(entry);
      events += entry[1].sequences.length;
      index += 1;
    }
    const done = yield* sql.withTransaction(foldBatch(sql, batch));
    totals.foldedMessages += done.foldedMessages;
    totals.removedMessageEvents += done.removedMessageEvents;
    totals.removedReceipts += done.removedReceipts;
    yield* options.pause;
  }

  yield* writeCursor(sql, key, heldFrom === null ? watermark : heldFrom - 1);
  return totals;
});

const foldBatch = (
  sql: SqlClient.SqlClient,
  batch: ReadonlyArray<readonly [string, MessagePlan]>,
) =>
  Effect.gen(function* () {
    const totals = { foldedMessages: 0, removedMessageEvents: 0, removedReceipts: 0 };
    for (const [messageId, plan] of batch) {
      const rows = yield* sql<{
        readonly sequence: number;
        readonly commandId: string | null;
        readonly payload: string;
      }>`
        SELECT sequence, command_id AS "commandId", payload_json AS payload
        FROM orchestration_events
        WHERE sequence IN (SELECT value FROM json_each(${JSON.stringify(plan.sequences)}))
        ORDER BY sequence ASC
      `;
      const projected = yield* sql<{ readonly text: string }>`
        SELECT text FROM projection_thread_messages
        WHERE message_id = ${messageId} AND is_streaming = 0
      `;
      const fold = foldMessageEvents(
        rows.map((row) => ({
          sequence: row.sequence,
          payload: JSON.parse(row.payload) as Record<string, unknown>,
        })),
        projected[0] ?? null,
      );
      if (!fold) continue;
      const removed = new Set(fold.removeSequences);
      const commandIds = rows.flatMap((row) =>
        removed.has(row.sequence) && row.commandId !== null ? [row.commandId] : [],
      );
      yield* sql`
        UPDATE orchestration_events
        SET payload_json = ${JSON.stringify(fold.payload)}
        WHERE sequence = ${fold.keepSequence}
      `;
      yield* sql`
        DELETE FROM orchestration_events
        WHERE sequence IN (SELECT value FROM json_each(${JSON.stringify(fold.removeSequences)}))
      `;
      yield* sql`
        DELETE FROM orchestration_command_receipts
        WHERE command_id IN (SELECT value FROM json_each(${JSON.stringify(commandIds)}))
      `;
      totals.foldedMessages += 1;
      totals.removedMessageEvents += fold.removeSequences.length;
      totals.removedReceipts += commandIds.length;
    }
    return totals;
  });

/** Old activity events whose row the chat reads from. The row stays. */
export const pruneActivityEvents = Effect.fn("DatabaseCompaction.activities")(function* (
  sql: SqlClient.SqlClient,
  watermark: number,
  options: CompactionOptions,
) {
  const totals = { removedActivityEvents: 0, removedReceipts: 0 };
  let cursor = yield* readCursor(sql, ACTIVITIES_CURSOR_KEY);
  while (cursor < watermark) {
    const upTo = Math.min(cursor + SCAN_PAGE_EVENTS, watermark);
    const rows = yield* sql<{ readonly sequence: number; readonly commandId: string | null }>`
      SELECT events.sequence AS sequence, events.command_id AS "commandId"
      FROM orchestration_events AS events
      INNER JOIN projection_thread_activities AS activities
        ON activities.activity_id = json_extract(events.payload_json, '$.activity.id')
      WHERE events.sequence > ${cursor}
        AND events.sequence <= ${upTo}
        AND events.event_type = 'thread.activity-appended'
      ORDER BY events.sequence ASC
      LIMIT ${PRUNE_BATCH_EVENTS}
    `;
    const full = rows.length === PRUNE_BATCH_EVENTS;
    const reached = full ? (rows.at(-1)?.sequence ?? upTo) : upTo;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (rows.length > 0) {
          const sequences = JSON.stringify(rows.map((row) => row.sequence));
          const commandIds = JSON.stringify(
            rows.flatMap((row) => (row.commandId === null ? [] : [row.commandId])),
          );
          yield* sql`
            DELETE FROM orchestration_events
            WHERE sequence IN (SELECT value FROM json_each(${sequences}))
          `;
          yield* sql`
            DELETE FROM orchestration_command_receipts
            WHERE command_id IN (SELECT value FROM json_each(${commandIds}))
          `;
        }
        yield* writeCursor(sql, ACTIVITIES_CURSOR_KEY, reached);
      }),
    );
    totals.removedActivityEvents += rows.length;
    totals.removedReceipts += rows.length;
    cursor = reached;
    yield* options.pause;
  }
  return totals;
});

/** One full pass. Safe to stop at any point and start again. */
export const runCompactionPass = Effect.fn("DatabaseCompaction.pass")(function* (
  sql: SqlClient.SqlClient,
  options: CompactionOptions & { readonly projectorCount: number },
) {
  const result = {
    foldedMessages: 0,
    removedMessageEvents: 0,
    removedActivityEvents: 0,
    removedReceipts: 0,
  };
  const watermarks = yield* readCompactionWatermarks(
    sql,
    options.now,
    options.projectorCount,
    options.keepRecentEvents,
  );
  if (watermarks.messages > 0) {
    let last = "";
    while (true) {
      const next = yield* sql<{ readonly id: string | null }>`
        SELECT MIN(stream_id) AS id FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id > ${last}
      `;
      const threadId = next[0]?.id ?? null;
      if (threadId === null) break;
      last = threadId;
      const done = yield* compactThreadMessages(sql, threadId, watermarks.messages, options);
      result.foldedMessages += done.foldedMessages;
      result.removedMessageEvents += done.removedMessageEvents;
      result.removedReceipts += done.removedReceipts;
    }
  }
  if (watermarks.activities > 0) {
    const done = yield* pruneActivityEvents(sql, watermarks.activities, options);
    result.removedActivityEvents += done.removedActivityEvents;
    result.removedReceipts += done.removedReceipts;
  }
  return result satisfies CompactionResult;
});

/** With incremental auto_vacuum, gives freed pages back to the disk a few at a time. */
export const shrinkIncrementally = Effect.fn("DatabaseCompaction.shrink")(function* (
  sql: SqlClient.SqlClient,
  pause: Effect.Effect<void>,
) {
  const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
  if (mode[0]?.auto_vacuum !== 2) return;
  while (true) {
    const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    if ((free[0]?.freelist_count ?? 0) === 0) return;
    yield* sql.unsafe("PRAGMA incremental_vacuum(2000)");
    yield* pause;
  }
});
