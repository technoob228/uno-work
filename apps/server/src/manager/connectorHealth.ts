/**
 * Connector health: how a poller turns provider failures into the
 * `ManagerConnectorHealthStatus` the UI shows, and how it paces itself while
 * the provider is unhappy. Pure functions over a small in-memory runtime
 * record; the persisted side (last_ok_at / last_error) is written by the
 * connector through `ManagerConnectorRepository.recordHealth`.
 *
 * Rules:
 * - network errors → `reconnecting`, exponential backoff (5s … 60s);
 * - provider 401/403 → `auth_expired`, retried at the slowest cadence (a bad
 *   token does not fix itself; the owner saving a new one resets the runtime);
 * - provider 5xx / 429 / 409 → `provider_unavailable`, same backoff as network;
 * - outbound send rejected after retries → `delivery_failed`, cleared by the
 *   next successful send (a good poll does not disprove an outbound problem);
 * - a successful poll → `connected` unless the connector is `delivery_failed`.
 *
 * Warnings are rate-limited to one per minute per connector unless the
 * status actually changed.
 */
import type { ManagerConnectorHealthStatus } from "@t3tools/contracts";
import { Effect } from "effect";

export type ConnectorFailureKind = "network" | "auth" | "provider" | "delivery";

export interface ConnectorFailure {
  readonly kind: ConnectorFailureKind;
  readonly message: string;
}

export interface ConnectorHealthRuntime {
  /** Null until the first poll has been observed. */
  readonly status: ManagerConnectorHealthStatus | null;
  readonly consecutiveFailures: number;
  /** Epoch ms before which the poller must not contact the provider again. */
  readonly nextAttemptAtMs: number;
  /** Epoch ms of the last warning written for this connector (rate limit). */
  readonly lastWarnedAtMs: number;
}

export const INITIAL_CONNECTOR_HEALTH: ConnectorHealthRuntime = {
  status: null,
  consecutiveFailures: 0,
  nextAttemptAtMs: 0,
  lastWarnedAtMs: 0,
};

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 60_000;
export const WARN_INTERVAL_MS = 60_000;

/** Delays between outbound send attempts: 3 attempts in total. */
export const SEND_RETRY_DELAYS_MS: ReadonlyArray<number> = [1_000, 3_000];

export const failureStatus = (kind: ConnectorFailureKind): ManagerConnectorHealthStatus => {
  switch (kind) {
    case "network":
      return "reconnecting";
    case "auth":
      return "auth_expired";
    case "provider":
      return "provider_unavailable";
    case "delivery":
      return "delivery_failed";
  }
};

/**
 * Map a Telegram Bot API `{ ok: false, error_code }` answer onto a failure
 * kind. Anything the provider answers that is not an auth or capacity
 * problem is still "the provider is not serving us" from the user's point
 * of view, so it lands on `provider` rather than being swallowed.
 */
export const classifyTelegramApiError = (input: {
  readonly errorCode?: number | undefined;
  readonly description?: string | undefined;
}): ConnectorFailure => {
  const description = input.description ?? "Telegram request rejected.";
  if (input.errorCode === 401 || input.errorCode === 403) {
    return { kind: "auth", message: description };
  }
  return { kind: "provider", message: description };
};

/** Retry only what a second attempt can plausibly fix. */
export const isRetriableTelegramApiError = (errorCode: number | undefined): boolean =>
  errorCode === undefined || errorCode === 429 || errorCode >= 500;

export const backoffDelayMs = (consecutiveFailures: number, kind: ConnectorFailureKind): number => {
  if (kind === "auth") {
    return BACKOFF_MAX_MS;
  }
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 8));
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent);
};

export interface HealthTransition {
  readonly runtime: ConnectorHealthRuntime;
  /** Set when the persisted status must change (or be stamped with a new error/ok time). */
  readonly status: ManagerConnectorHealthStatus;
  readonly statusChanged: boolean;
  /** Whether a warning line is due under the once-per-minute rule. */
  readonly shouldWarn: boolean;
}

export const onPollSuccess = (
  runtime: ConnectorHealthRuntime,
  _nowMs: number,
): HealthTransition => {
  const status: ManagerConnectorHealthStatus =
    runtime.status === "delivery_failed" ? "delivery_failed" : "connected";
  return {
    runtime: { ...runtime, status, consecutiveFailures: 0, nextAttemptAtMs: 0 },
    status,
    statusChanged: runtime.status !== status,
    shouldWarn: false,
  };
};

export const onPollFailure = (
  runtime: ConnectorHealthRuntime,
  kind: Exclude<ConnectorFailureKind, "delivery">,
  nowMs: number,
): HealthTransition => {
  const status = failureStatus(kind);
  const consecutiveFailures = runtime.consecutiveFailures + 1;
  const statusChanged = runtime.status !== status;
  const shouldWarn = statusChanged || nowMs - runtime.lastWarnedAtMs >= WARN_INTERVAL_MS;
  return {
    runtime: {
      status,
      consecutiveFailures,
      nextAttemptAtMs: nowMs + backoffDelayMs(consecutiveFailures, kind),
      lastWarnedAtMs: shouldWarn ? nowMs : runtime.lastWarnedAtMs,
    },
    status,
    statusChanged,
    shouldWarn,
  };
};

/** Outbound delivery is orthogonal to polling: it never touches the poll backoff. */
export const onDeliveryOutcome = (
  runtime: ConnectorHealthRuntime,
  delivered: boolean,
  nowMs: number,
): HealthTransition | null => {
  if (delivered) {
    if (runtime.status !== "delivery_failed") {
      return null;
    }
    return {
      runtime: { ...runtime, status: "connected" },
      status: "connected",
      statusChanged: true,
      shouldWarn: false,
    };
  }
  const statusChanged = runtime.status !== "delivery_failed";
  const shouldWarn = statusChanged || nowMs - runtime.lastWarnedAtMs >= WARN_INTERVAL_MS;
  return {
    runtime: {
      ...runtime,
      status: "delivery_failed",
      lastWarnedAtMs: shouldWarn ? nowMs : runtime.lastWarnedAtMs,
    },
    status: "delivery_failed",
    statusChanged,
    shouldWarn,
  };
};

export const isBackingOff = (runtime: ConnectorHealthRuntime, nowMs: number): boolean =>
  nowMs < runtime.nextAttemptAtMs;

/**
 * Run `attempt` up to `delaysMs.length + 1` times, sleeping the listed delay
 * between tries, retrying only failures `retriable` accepts. The last failure
 * is returned as-is so the caller can classify and record it.
 */
export const attemptWithBackoff = <A, E, R>(
  attempt: Effect.Effect<A, E, R>,
  options: {
    readonly retriable: (error: E) => boolean;
    readonly delaysMs: ReadonlyArray<number>;
  },
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    let index = 0;
    while (true) {
      const outcome = yield* attempt.pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catch((error: E) => Effect.succeed({ ok: false as const, error })),
      );
      if (outcome.ok) {
        return outcome.value;
      }
      const delay = options.delaysMs[index];
      if (delay === undefined || !options.retriable(outcome.error)) {
        return yield* Effect.fail(outcome.error);
      }
      index += 1;
      yield* Effect.sleep(delay);
    }
  });
