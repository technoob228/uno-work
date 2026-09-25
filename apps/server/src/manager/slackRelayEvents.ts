/**
 * Event source of a relay-mode Slack connector ("Add to Slack" with Uno's
 * app): instead of a Socket Mode connection, long-poll the console's
 * per-computer queue
 *
 *   GET <console>/api/v1/work-relay/slack/<slr>/events?after=<cursor>&wait=25
 *   → {"events":[{"cursor":"42","payload":{…Events API outer payload…}}],"cursor":"42"}
 *
 * and feed every payload's `event` into the same handler Socket Mode events
 * go through. Delivery reuses the Telegram durability: each envelope goes
 * through the connector inbox (`connectorInbox.ts`), and the cursor is
 * persisted in `manager_connector_state.offset` only once the event is
 * terminal — a restart neither replays handled events nor loses unhandled
 * ones (the console acks everything ≤ `after`).
 *
 * Health and backoff follow `connectorHealth.ts`, like the Telegram poller.
 *
 * @module manager/slackRelayEvents
 */
import { Data, Duration, Effect, Option } from "effect";
import * as crypto from "node:crypto";

import type { ManagerRepositoryError } from "../persistence/Errors.ts";
import {
  ManagerConnectorRepository,
  type ManagerConnectorKey,
} from "../persistence/Services/ManagerConnectors.ts";
import {
  RELAY_CREDENTIAL_PREFIX,
  redactConnectorSecrets,
  slackRelayEventsUrl,
} from "./channelRelay.ts";
import {
  INITIAL_CONNECTOR_HEALTH,
  onPollFailure,
  onPollSuccess,
  type ConnectorFailureKind,
  type ConnectorHealthRuntime,
} from "./connectorHealth.ts";
import {
  processInboxEvents,
  recoverPendingEvents,
  type ConnectorInboxHandler,
} from "./connectorInbox.ts";
import type { FetchLike } from "./workConsole.ts";

/** Long-poll window asked of the console (it allows 0..50). */
export const SLACK_RELAY_WAIT_SECONDS = 25;
/** Pause after an empty poll (see `slackRelayLoopStep`). */
export const SLACK_RELAY_IDLE_PAUSE_MS = 1_000;
/** Client-side ceiling of one long poll: the wait plus generous slack. */
const SLACK_RELAY_REQUEST_TIMEOUT_MS = (SLACK_RELAY_WAIT_SECONDS + 20) * 1000;

/** The Events API outer payload, loosely typed (only what routing reads). */
export interface SlackEventsApiPayload {
  readonly type?: string;
  readonly team_id?: string;
  readonly event_id?: string;
  readonly event?: unknown;
}

export interface SlackRelayEnvelope {
  readonly cursor: string;
  readonly payload: SlackEventsApiPayload;
}

export class SlackRelayPollError extends Data.TaggedError("SlackRelayPollError")<{
  readonly kind: Exclude<ConnectorFailureKind, "delivery">;
  readonly message: string;
}> {}

/**
 * The queue's identity for `manager_connector_state`: relay tokens rotate
 * (each setup mints a new one) but the queue and its cursors stay, so every
 * relay credential shares one fingerprint — rotation neither replays nor
 * drops events.
 */
export const SLACK_RELAY_FINGERPRINT = crypto
  .createHash("sha256")
  .update(`slack:${RELAY_CREDENTIAL_PREFIX}`)
  .digest("hex")
  .slice(0, 16);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Shape check for an envelope from the console or replayed from the inbox. */
export const decodeSlackRelayEnvelope = (value: unknown): SlackRelayEnvelope | null => {
  if (!isRecord(value)) return null;
  const cursor = value["cursor"];
  const payload = value["payload"];
  const cursorText =
    typeof cursor === "string" ? cursor : typeof cursor === "number" ? String(cursor) : null;
  if (cursorText === null || cursorText.length === 0 || !isRecord(payload)) return null;
  return { cursor: cursorText, payload: payload as SlackEventsApiPayload };
};

/** The numeric cursor persisted as the state offset; null when not numeric. */
export const slackRelayOffsetAfter = (envelope: SlackRelayEnvelope): number | null => {
  const value = Number(envelope.cursor);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};

/** Inbox dedupe key: Slack's own event id, else the queue cursor. */
export const slackRelayEventId = (envelope: SlackRelayEnvelope): string =>
  typeof envelope.payload.event_id === "string" && envelope.payload.event_id.length > 0
    ? envelope.payload.event_id
    : `cursor:${envelope.cursor}`;

const classifyStatus = (status: number): Exclude<ConnectorFailureKind, "delivery"> =>
  status === 401 || status === 403 || status === 404 ? "auth" : "provider";

/** One long poll of the relay queue. */
export const fetchSlackRelayEvents = (input: {
  readonly relayToken: string;
  readonly after: string;
  readonly waitSeconds?: number;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<ReadonlyArray<SlackRelayEnvelope>, SlackRelayPollError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: async () => {
        const fetchImpl = input.fetchImpl ?? globalThis.fetch;
        const answer = await fetchImpl(
          slackRelayEventsUrl(
            input.relayToken,
            input.after,
            input.waitSeconds ?? SLACK_RELAY_WAIT_SECONDS,
          ),
          { signal: AbortSignal.timeout(SLACK_RELAY_REQUEST_TIMEOUT_MS) },
        );
        const text = await answer.text().catch(() => "");
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        return { status: answer.status, body };
      },
      catch: (cause) =>
        new SlackRelayPollError({
          kind: "network",
          message: `Slack relay unreachable: ${redactConnectorSecrets(
            cause instanceof Error ? cause.message : String(cause),
          )}`,
        }),
    });
    if (response.status < 200 || response.status >= 300) {
      return yield* new SlackRelayPollError({
        kind: classifyStatus(response.status),
        message:
          classifyStatus(response.status) === "auth"
            ? "The Slack relay no longer accepts this computer; set up Slack again."
            : `Slack relay answered HTTP ${response.status}.`,
      });
    }
    const events = isRecord(response.body) ? response.body["events"] : undefined;
    if (!Array.isArray(events)) {
      return yield* new SlackRelayPollError({
        kind: "provider",
        message: "Slack relay answered with an unexpected body.",
      });
    }
    return events.flatMap((event) => {
      const decoded = decodeSlackRelayEnvelope(event);
      return decoded === null ? [] : [decoded];
    });
  });

export const slackRelayInboxHandler = <E, R>(
  key: ManagerConnectorKey,
  handle: (payload: SlackEventsApiPayload) => Effect.Effect<void, E, R>,
): ConnectorInboxHandler<SlackRelayEnvelope, E, R> => ({
  key,
  handle: (envelope) => handle(envelope.payload),
  offsetAfter: slackRelayOffsetAfter,
});

/**
 * Bind the persisted state to the relay queue (fresh row, or one that
 * belonged to Socket Mode / another credential → cursor 0, inbox cleared)
 * and replay what a previous run received but never settled.
 */
export const initializeSlackRelayState = <E, R>(input: {
  readonly key: ManagerConnectorKey;
  readonly handle: (payload: SlackEventsApiPayload) => Effect.Effect<void, E, R>;
}): Effect.Effect<void, ManagerRepositoryError, ManagerConnectorRepository | R> =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    const existing = yield* repository.getState(input.key);
    if (
      Option.isNone(existing) ||
      existing.value.credentialFingerprint !== SLACK_RELAY_FINGERPRINT
    ) {
      yield* repository.resetState({
        ...input.key,
        credentialFingerprint: SLACK_RELAY_FINGERPRINT,
        updatedAt: new Date().toISOString(),
      });
      return;
    }
    yield* recoverPendingEvents(slackRelayInboxHandler(input.key, input.handle), {
      decode: decodeSlackRelayEnvelope,
    });
  });

/**
 * Fetch the next batch after the persisted cursor and settle each event
 * through the inbox. Returns how many events came in.
 */
export const pollSlackRelayOnce = <E, R>(input: {
  readonly key: ManagerConnectorKey;
  readonly relayToken: string;
  readonly handle: (payload: SlackEventsApiPayload) => Effect.Effect<void, E, R>;
  readonly waitSeconds?: number;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<
  number,
  SlackRelayPollError | ManagerRepositoryError,
  ManagerConnectorRepository | R
> =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    const state = yield* repository.getState(input.key);
    const after = Option.isSome(state) ? String(state.value.offset) : "0";
    const events = yield* fetchSlackRelayEvents({
      relayToken: input.relayToken,
      after,
      ...(input.waitSeconds !== undefined ? { waitSeconds: input.waitSeconds } : {}),
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
    });
    if (events.length === 0) return 0;
    yield* processInboxEvents(
      slackRelayInboxHandler(input.key, input.handle),
      events.map((envelope) => ({
        providerEventId: slackRelayEventId(envelope),
        payload: envelope,
      })),
    );
    return events.length;
  });

export interface SlackRelayStepResult {
  readonly health: ConnectorHealthRuntime;
  /** The error to surface, or null after a successful poll. */
  readonly error: string | null;
  /** How long to wait before the next poll (backoff after failures). */
  readonly delayMs: number;
}

/**
 * One loop iteration: poll, then derive the new health and the delay before
 * the next poll. A poll that brought events goes straight into the next one; a
 * failure backs off exponentially (auth failures at the ceiling). Repository
 * failures (not the console's fault) back off like a provider error.
 */
export const slackRelayLoopStep = <E, R>(input: {
  readonly key: ManagerConnectorKey;
  readonly relayToken: string;
  readonly health: ConnectorHealthRuntime;
  readonly handle: (payload: SlackEventsApiPayload) => Effect.Effect<void, E, R>;
  readonly waitSeconds?: number;
  readonly fetchImpl?: FetchLike;
  readonly nowMs?: () => number;
}): Effect.Effect<SlackRelayStepResult, never, ManagerConnectorRepository | R> =>
  pollSlackRelayOnce(input).pipe(
    Effect.map(
      (received): SlackRelayStepResult => ({
        health: onPollSuccess(input.health, (input.nowMs ?? Date.now)()).runtime,
        error: null,
        // An empty answer already waited out the long poll; the pause only
        // guards against a console that answers empty at once.
        delayMs: received > 0 ? 0 : SLACK_RELAY_IDLE_PAUSE_MS,
      }),
    ),
    Effect.catch((cause) => {
      const nowMs = (input.nowMs ?? Date.now)();
      const failure =
        cause._tag === "SlackRelayPollError"
          ? { kind: cause.kind, message: cause.message }
          : { kind: "provider" as const, message: "Slack relay state could not be saved." };
      const transition = onPollFailure(input.health, failure.kind, nowMs);
      return Effect.succeed({
        health: transition.runtime,
        error: failure.message,
        delayMs: Math.max(0, transition.runtime.nextAttemptAtMs - nowMs),
      });
    }),
  );

/**
 * The relay event loop of one connector; runs until interrupted. `onStatus`
 * hears every change between healthy and failing (with the error), so the
 * connector can surface it; the health row is persisted on each change.
 */
export const runSlackRelayEventLoop = <E, R>(input: {
  readonly key: ManagerConnectorKey;
  readonly relayToken: string;
  readonly handle: (payload: SlackEventsApiPayload) => Effect.Effect<void, E, R>;
  readonly onStatus: (status: {
    readonly connected: boolean;
    readonly error: string | null;
  }) => void;
  readonly fetchImpl?: FetchLike;
}): Effect.Effect<never, ManagerRepositoryError, ManagerConnectorRepository | R> =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    yield* initializeSlackRelayState({ key: input.key, handle: input.handle });
    let health = INITIAL_CONNECTOR_HEALTH;
    let lastError: string | null | undefined;
    return yield* Effect.forever(
      Effect.gen(function* () {
        const step = yield* slackRelayLoopStep({ ...input, health });
        const changed = step.health.status !== health.status || step.error !== lastError;
        health = step.health;
        if (changed) {
          lastError = step.error;
          input.onStatus({ connected: step.error === null, error: step.error });
          if (step.health.status !== null) {
            yield* repository
              .recordHealth({
                ...input.key,
                status: step.health.status,
                error: step.error,
                at: new Date().toISOString(),
              })
              .pipe(Effect.ignore);
          }
          if (step.error !== null) {
            yield* Effect.logWarning("slack relay poll failed").pipe(
              Effect.annotateLogs({ projectId: input.key.projectId, error: step.error }),
            );
          }
        }
        if (step.delayMs > 0) {
          yield* Effect.sleep(Duration.millis(step.delayMs));
        }
      }),
    );
  });
