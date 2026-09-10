/**
 * Durable inbox pipeline shared by connector pollers.
 *
 * Per event: insert an inbox row (idempotent on the provider's event id —
 * a duplicate that is already terminal is skipped), handle it, mark it
 * terminal, and only THEN move the persisted resume cursor past it. A crash
 * anywhere before the cursor moves leaves the row `received`, and
 * `recoverPendingEvents` replays it from the stored payload on the next
 * start. `attempts` bounds that replay: an event that keeps crashing the
 * daemon is marked `failed` instead of looping forever.
 *
 * Handling failures are terminal on the spot (status `failed`, error kept):
 * re-running a half-dispatched turn is riskier than recording it, and the
 * cursor still advances so the poller does not fetch the same event forever.
 */
import { Effect } from "effect";

import type { ManagerRepositoryError } from "../persistence/Errors.ts";
import {
  ManagerConnectorRepository,
  type ManagerConnectorKey,
} from "../persistence/Services/ManagerConnectors.ts";

/** Replay bound: a crash mid-handling this many times marks the event failed. */
export const INBOX_MAX_ATTEMPTS = 3;
/** Restart recovery replays at most this many unhandled rows per connector. */
export const INBOX_RECOVERY_LIMIT = 50;

export interface ConnectorInboxEvent<Payload> {
  readonly providerEventId: string;
  readonly payload: Payload;
}

export interface ConnectorInboxHandler<Payload, E = never, R = never> {
  readonly key: ManagerConnectorKey;
  readonly handle: (payload: Payload) => Effect.Effect<void, E, R>;
  /**
   * The resume cursor to persist once this event is terminal, or null when
   * the provider has no cursor semantics (Slack). Telegram: `update_id + 1`.
   */
  readonly offsetAfter: (payload: Payload) => number | null;
  readonly now?: () => Date;
}

export type ConnectorInboxOutcome = "handled" | "failed" | "duplicate" | "exhausted";

export interface ConnectorInboxSummary {
  readonly handled: number;
  readonly failed: number;
  readonly duplicates: number;
  readonly exhausted: number;
}

const describeFailure = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Handle an event already present in the inbox (fresh or replayed) and settle its row. */
const settleEvent = <Payload, E, R>(
  handler: ConnectorInboxHandler<Payload, E, R>,
  event: ConnectorInboxEvent<Payload>,
): Effect.Effect<
  Exclude<ConnectorInboxOutcome, "duplicate">,
  ManagerRepositoryError,
  ManagerConnectorRepository | R
> =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    const now = handler.now ?? (() => new Date());
    const eventKey = { ...handler.key, providerEventId: event.providerEventId };

    const attempts = yield* repository.beginInboxAttempt(eventKey);
    let outcome: Exclude<ConnectorInboxOutcome, "duplicate">;
    if (attempts > INBOX_MAX_ATTEMPTS) {
      yield* repository.markInboxFailed({
        ...eventKey,
        error: `Gave up after ${attempts - 1} attempts (daemon crashed while handling).`,
        failedAt: now().toISOString(),
      });
      outcome = "exhausted";
    } else {
      const failure = yield* handler.handle(event.payload).pipe(
        Effect.map(() => null),
        Effect.catch((cause) => Effect.succeed(describeFailure(cause))),
      );
      if (failure === null) {
        yield* repository.markInboxHandled({ ...eventKey, handledAt: now().toISOString() });
        outcome = "handled";
      } else {
        yield* repository.markInboxFailed({
          ...eventKey,
          error: failure,
          failedAt: now().toISOString(),
        });
        outcome = "failed";
      }
    }

    // Terminal either way — now, and only now, the cursor may pass this event.
    const offset = handler.offsetAfter(event.payload);
    if (offset !== null) {
      yield* repository.advanceOffset({
        ...handler.key,
        offset,
        updatedAt: now().toISOString(),
      });
    }
    return outcome;
  });

/**
 * Process a batch of freshly fetched provider events in order. Returns the
 * per-event outcomes (same order as `events`) so the caller can log or test
 * them; the cursor has already been persisted for every terminal event.
 */
export const processInboxEvents = <Payload, E = never, R = never>(
  handler: ConnectorInboxHandler<Payload, E, R>,
  events: ReadonlyArray<ConnectorInboxEvent<Payload>>,
): Effect.Effect<
  ReadonlyArray<ConnectorInboxOutcome>,
  ManagerRepositoryError,
  ManagerConnectorRepository | R
> =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    const now = handler.now ?? (() => new Date());
    const outcomes: Array<ConnectorInboxOutcome> = [];
    for (const event of events) {
      const inserted = yield* repository.insertInboxEvent({
        ...handler.key,
        providerEventId: event.providerEventId,
        payload: event.payload,
        receivedAt: now().toISOString(),
      });
      if (inserted === "handled" || inserted === "failed") {
        // Re-delivered by the provider after we settled it (offset write
        // lost to a crash, or the provider's own retry). The cursor may
        // still be behind it, so let it catch up — without re-handling.
        const offset = handler.offsetAfter(event.payload);
        if (offset !== null) {
          yield* repository.advanceOffset({
            ...handler.key,
            offset,
            updatedAt: now().toISOString(),
          });
        }
        outcomes.push("duplicate");
        continue;
      }
      // `inserted` or a `received` row from an earlier crash: handle it.
      outcomes.push(yield* settleEvent(handler, event));
    }
    return outcomes;
  });

/**
 * Restart recovery: replay rows that were received but never settled,
 * oldest first, bounded by `limit`. Payloads are decoded by `decode`; a row
 * whose payload no longer decodes is marked failed rather than replayed.
 */
export const recoverPendingEvents = <Payload, E = never, R = never>(
  handler: ConnectorInboxHandler<Payload, E, R>,
  options: {
    readonly decode: (payload: unknown) => Payload | null;
    readonly limit?: number;
  },
): Effect.Effect<ConnectorInboxSummary, ManagerRepositoryError, ManagerConnectorRepository | R> =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    const now = handler.now ?? (() => new Date());
    const pending = yield* repository.listPendingInbox({
      ...handler.key,
      limit: options.limit ?? INBOX_RECOVERY_LIMIT,
    });
    const summary = { handled: 0, failed: 0, duplicates: 0, exhausted: 0 };
    for (const row of pending) {
      const payload = options.decode(row.payload);
      if (payload === null) {
        yield* repository.markInboxFailed({
          ...handler.key,
          providerEventId: row.providerEventId,
          error: "Stored payload is not decodable; skipped on recovery.",
          failedAt: now().toISOString(),
        });
        summary.failed += 1;
        continue;
      }
      const outcome = yield* settleEvent(handler, {
        providerEventId: row.providerEventId,
        payload,
      });
      if (outcome === "handled") summary.handled += 1;
      else if (outcome === "failed") summary.failed += 1;
      else summary.exhausted += 1;
    }
    return summary;
  });
