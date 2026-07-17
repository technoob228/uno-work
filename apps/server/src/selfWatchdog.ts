import { Duration, Effect, Exit, Layer } from "effect";

import { HealthCheck } from "./health.ts";

const WATCHDOG_INTERVAL = Duration.seconds(60);
const WATCHDOG_MAX_CONSECUTIVE_FAILURES = 3;
/** EX_SOFTWARE — distinguishes a deliberate watchdog exit in supervisor logs. */
const WATCHDOG_EXIT_CODE = 70;

export const isWatchdogExitEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env["T3_WATCHDOG_EXIT"] === "1";

/**
 * Dead-man's switch for the half-dead daemon failure mode: HTTP keeps
 * answering while every database write fails. The watchdog runs the same
 * write-capable probe as /api/health once a minute; after three consecutive
 * failures it exits so the process supervisor (systemd Restart=always)
 * replaces the process with a healthy one.
 *
 * Exiting is gated on T3_WATCHDOG_EXIT=1, which only the systemd unit sets —
 * a desktop-child or nohup-launched server has no supervisor to bring it
 * back, so there it logs loudly instead of dying into nothingness.
 */
export const SelfWatchdogLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const healthCheck = yield* HealthCheck;
    const exitEnabled = isWatchdogExitEnabled();
    let consecutiveFailures = 0;

    const loop = Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(WATCHDOG_INTERVAL);
        const probeExit = yield* Effect.exit(healthCheck.probe);
        if (Exit.isSuccess(probeExit)) {
          consecutiveFailures = 0;
          continue;
        }
        consecutiveFailures += 1;
        yield* Effect.logError("watchdog.selfcheck.failed", {
          consecutiveFailures,
          maxConsecutiveFailures: WATCHDOG_MAX_CONSECUTIVE_FAILURES,
          exitEnabled,
          cause: probeExit.cause,
        });
        if (consecutiveFailures < WATCHDOG_MAX_CONSECUTIVE_FAILURES) {
          continue;
        }
        if (exitEnabled) {
          yield* Effect.logFatal(
            "watchdog: persistence selfcheck failed repeatedly; exiting for supervisor restart",
            { consecutiveFailures },
          );
          return yield* Effect.sync(() => {
            process.exit(WATCHDOG_EXIT_CODE);
          });
        }
        // Without a supervisor there is nothing useful in dying; keep
        // logging one error per interval instead of escalating further.
        consecutiveFailures = 0;
      }
    });

    yield* Effect.forkScoped(loop.pipe(Effect.ignoreCause({ log: true })));
  }),
);
