import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  attemptWithBackoff,
  BACKOFF_MAX_MS,
  classifyTelegramApiError,
  INITIAL_CONNECTOR_HEALTH,
  isBackingOff,
  isRetriableTelegramApiError,
  onDeliveryOutcome,
  onPollFailure,
  onPollSuccess,
  WARN_INTERVAL_MS,
} from "./connectorHealth.ts";

const T0 = 1_000_000;

describe("classifyTelegramApiError", () => {
  it("treats 401/403 as an expired credential", () => {
    expect(classifyTelegramApiError({ errorCode: 401, description: "Unauthorized" })).toEqual({
      kind: "auth",
      message: "Unauthorized",
    });
    expect(classifyTelegramApiError({ errorCode: 403 }).kind).toBe("auth");
  });

  it("treats everything else the provider answers as provider trouble", () => {
    expect(classifyTelegramApiError({ errorCode: 502, description: "Bad Gateway" }).kind).toBe(
      "provider",
    );
    expect(classifyTelegramApiError({ errorCode: 429 }).kind).toBe("provider");
    expect(classifyTelegramApiError({ errorCode: 409 }).kind).toBe("provider");
    expect(classifyTelegramApiError({}).message).toBe("Telegram request rejected.");
  });

  it("retries only what a second attempt can fix", () => {
    expect(isRetriableTelegramApiError(undefined)).toBe(true);
    expect(isRetriableTelegramApiError(429)).toBe(true);
    expect(isRetriableTelegramApiError(500)).toBe(true);
    expect(isRetriableTelegramApiError(400)).toBe(false);
    expect(isRetriableTelegramApiError(403)).toBe(false);
  });
});

describe("poll health transitions", () => {
  it("a network error moves to reconnecting and backs off exponentially", () => {
    const first = onPollFailure(INITIAL_CONNECTOR_HEALTH, "network", T0);
    expect(first.status).toBe("reconnecting");
    expect(first.statusChanged).toBe(true);
    expect(first.shouldWarn).toBe(true);
    expect(first.runtime.nextAttemptAtMs).toBe(T0 + 5_000);
    expect(isBackingOff(first.runtime, T0 + 4_999)).toBe(true);
    expect(isBackingOff(first.runtime, T0 + 5_000)).toBe(false);

    const second = onPollFailure(first.runtime, "network", T0 + 5_000);
    expect(second.runtime.nextAttemptAtMs).toBe(T0 + 5_000 + 10_000);
    const third = onPollFailure(second.runtime, "network", T0 + 15_000);
    expect(third.runtime.nextAttemptAtMs).toBe(T0 + 15_000 + 20_000);

    let runtime = third.runtime;
    for (let i = 0; i < 10; i += 1) {
      runtime = onPollFailure(runtime, "network", T0).runtime;
    }
    expect(runtime.nextAttemptAtMs - T0).toBe(BACKOFF_MAX_MS);
  });

  it("warns at most once per minute per connector while the status is unchanged", () => {
    const first = onPollFailure(INITIAL_CONNECTOR_HEALTH, "network", T0);
    expect(first.shouldWarn).toBe(true);
    const soon = onPollFailure(first.runtime, "network", T0 + 10_000);
    expect(soon.shouldWarn).toBe(false);
    expect(soon.runtime.lastWarnedAtMs).toBe(T0);
    const later = onPollFailure(soon.runtime, "network", T0 + WARN_INTERVAL_MS);
    expect(later.shouldWarn).toBe(true);
    expect(later.runtime.lastWarnedAtMs).toBe(T0 + WARN_INTERVAL_MS);
  });

  it("a 401/403 moves to auth_expired at the slowest cadence and warns on the change", () => {
    const network = onPollFailure(INITIAL_CONNECTOR_HEALTH, "network", T0);
    const auth = onPollFailure(network.runtime, "auth", T0 + 1_000);
    expect(auth.status).toBe("auth_expired");
    expect(auth.statusChanged).toBe(true);
    // Status changed → warn even though the last warning was a second ago.
    expect(auth.shouldWarn).toBe(true);
    expect(auth.runtime.nextAttemptAtMs).toBe(T0 + 1_000 + BACKOFF_MAX_MS);
  });

  it("a 5xx moves to provider_unavailable", () => {
    expect(onPollFailure(INITIAL_CONNECTOR_HEALTH, "provider", T0).status).toBe(
      "provider_unavailable",
    );
  });

  it("a successful poll clears failures and returns to connected", () => {
    const failing = onPollFailure(INITIAL_CONNECTOR_HEALTH, "auth", T0);
    const recovered = onPollSuccess(failing.runtime, T0 + 60_000);
    expect(recovered.status).toBe("connected");
    expect(recovered.statusChanged).toBe(true);
    expect(recovered.runtime.consecutiveFailures).toBe(0);
    expect(recovered.runtime.nextAttemptAtMs).toBe(0);
    expect(onPollSuccess(recovered.runtime, T0 + 70_000).statusChanged).toBe(false);
  });
});

describe("delivery health", () => {
  it("a rejected send marks delivery_failed until a later send succeeds", () => {
    const connected = onPollSuccess(INITIAL_CONNECTOR_HEALTH, T0).runtime;
    const failed = onDeliveryOutcome(connected, false, T0 + 1_000);
    expect(failed?.status).toBe("delivery_failed");
    expect(failed?.statusChanged).toBe(true);
    // A good poll does not disprove an outbound problem.
    expect(onPollSuccess(failed!.runtime, T0 + 2_000).status).toBe("delivery_failed");
    // A good send does.
    const cleared = onDeliveryOutcome(failed!.runtime, true, T0 + 3_000);
    expect(cleared?.status).toBe("connected");
    // And a good send on a healthy connector is a no-op.
    expect(onDeliveryOutcome(cleared!.runtime, true, T0 + 4_000)).toBeNull();
  });

  it("delivery outcomes never touch the poll backoff", () => {
    const backingOff = onPollFailure(INITIAL_CONNECTOR_HEALTH, "network", T0).runtime;
    const failed = onDeliveryOutcome(backingOff, false, T0 + 100);
    expect(failed?.runtime.nextAttemptAtMs).toBe(backingOff.nextAttemptAtMs);
  });
});

describe("attemptWithBackoff", () => {
  it.effect("retries retriable failures up to the delay count, then surfaces the last error", () =>
    Effect.gen(function* () {
      let calls = 0;
      const attempt = Effect.suspend(() => {
        calls += 1;
        return Effect.fail({ retriable: true, attempt: calls });
      });
      const error = yield* Effect.flip(
        attemptWithBackoff(attempt, { retriable: (e) => e.retriable, delaysMs: [0, 0] }),
      );
      expect(calls).toBe(3);
      expect(error.attempt).toBe(3);
    }),
  );

  it.effect("stops at once on a non-retriable failure and returns the first success", () =>
    Effect.gen(function* () {
      let calls = 0;
      const nonRetriable = Effect.suspend(() => {
        calls += 1;
        return Effect.fail({ retriable: false });
      });
      yield* Effect.flip(
        attemptWithBackoff(nonRetriable, { retriable: (e) => e.retriable, delaysMs: [0, 0] }),
      );
      expect(calls).toBe(1);

      let flaky = 0;
      const succeedsSecondTime = Effect.suspend(() => {
        flaky += 1;
        return flaky < 2 ? Effect.fail({ retriable: true }) : Effect.succeed("ok");
      });
      const value = yield* attemptWithBackoff(succeedsSecondTime, {
        retriable: (e) => e.retriable,
        delaysMs: [0, 0],
      });
      expect(value).toBe("ok");
      expect(flaky).toBe(2);
    }),
  );
});
