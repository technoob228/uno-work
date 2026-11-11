import { Cause, Duration, Effect, Exit, Layer } from "effect";

import { HealthCheck, type HealthCheckShape } from "./health.ts";

const WATCHDOG_INTERVAL = Duration.seconds(60);
const WATCHDOG_MAX_CONSECUTIVE_FAILURES = 3;
/**
 * Longer than `/api/health`'s 3 s: a stuck database never answers, so waiting
 * longer costs nothing, while a busy one (a build loading every core, a large
 * snapshot query) gets the time it needs instead of a restart that would stop
 * every running chat.
 */
const WATCHDOG_PROBE_TIMEOUT = Duration.seconds(15);
/** EX_SOFTWARE — distinguishes a deliberate watchdog exit in supervisor logs. */
export const WATCHDOG_EXIT_CODE = 70;

const WATCHDOG_EXIT_ENV = "T3_WATCHDOG_EXIT";

export const isWatchdogExitEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env[WATCHDOG_EXIT_ENV] === "1";

/**
 * Reads the flag and removes it from the environment: it belongs to this
 * process and its supervisor only. Everything the daemon starts (agents,
 * terminals, a `uno-work serve` an agent runs while building Uno Work itself)
 * inherits the environment and has no supervisor behind it.
 */
export const consumeWatchdogExitFlag = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const enabled = isWatchdogExitEnabled(env);
  delete env[WATCHDOG_EXIT_ENV];
  return enabled;
};

let exitEnabledAtStart: boolean | undefined;

/**
 * The flag as the process started with it, read once. The server calls this
 * before building anything that could start a child process.
 */
export const takeWatchdogExitFlagAtStart = (): boolean =>
  (exitEnabledAtStart ??= consumeWatchdogExitFlag());

export interface SelfWatchdogOptions {
  readonly probe: HealthCheckShape["probeWithin"];
  readonly exitEnabled: boolean;
  readonly exit: (code: number) => void;
}

/**
 * The watchdog's loop; never returns on its own. Exposed for tests, which
 * drive it with a fake probe, a fake exit and the test clock.
 */
export const runSelfWatchdog = (options: SelfWatchdogOptions): Effect.Effect<void> =>
  Effect.gen(function* () {
    let consecutiveFailures = 0;
    for (;;) {
      yield* Effect.sleep(WATCHDOG_INTERVAL);
      // The probe is bounded by its own timeout; this outer bound only guards
      // against a probe whose timeout could not interrupt it.
      const probeExit = yield* Effect.exit(
        options.probe(WATCHDOG_PROBE_TIMEOUT).pipe(
          Effect.timeoutOrElse({
            duration: Duration.sum(WATCHDOG_PROBE_TIMEOUT, Duration.seconds(5)),
            orElse: () => Effect.fail(new Error("health probe did not return")),
          }),
        ),
      );
      if (Exit.isSuccess(probeExit)) {
        consecutiveFailures = 0;
        continue;
      }
      consecutiveFailures += 1;
      // A string: the structured cause showed up in the journal as `[Object]`.
      yield* Effect.logError("watchdog.selfcheck.failed", {
        consecutiveFailures,
        maxConsecutiveFailures: WATCHDOG_MAX_CONSECUTIVE_FAILURES,
        exitEnabled: options.exitEnabled,
        cause: Cause.pretty(probeExit.cause).split("\n", 1)[0],
      });
      if (consecutiveFailures < WATCHDOG_MAX_CONSECUTIVE_FAILURES) {
        continue;
      }
      if (options.exitEnabled) {
        yield* Effect.logFatal(
          "watchdog: persistence selfcheck failed repeatedly; exiting for supervisor restart",
          { consecutiveFailures },
        );
        yield* Effect.sync(() => options.exit(WATCHDOG_EXIT_CODE));
        return;
      }
      // Without a supervisor there is nothing useful in dying; keep
      // logging one error per interval instead of escalating further.
      consecutiveFailures = 0;
    }
  });

/**
 * Dead-man's switch for the half-dead daemon failure mode: HTTP keeps
 * answering while every database call fails or hangs. The watchdog runs the
 * same write-capable probe as /api/health once a minute; after three
 * consecutive failures it exits so the process supervisor (systemd
 * Restart=always) replaces the process with a healthy one.
 *
 * Exiting is gated on T3_WATCHDOG_EXIT=1, which only the systemd units set
 * (deploy/uno-work.service on Uno computers, the ssh-installed unit in
 * packages/ssh) — a desktop-child or nohup-launched server has no supervisor
 * to bring it back, so there it logs loudly instead of dying into nothingness.
 * `process.exit` does not wait for a graceful shutdown: a wedged daemon can't
 * finish one (box 395 on 11.11 ignored SIGTERM until systemd killed it).
 */
export const SelfWatchdogLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const healthCheck = yield* HealthCheck;
    const exitEnabled = takeWatchdogExitFlagAtStart();
    yield* Effect.forkScoped(
      runSelfWatchdog({
        probe: healthCheck.probeWithin,
        exitEnabled,
        exit: (code) => process.exit(code),
      }).pipe(Effect.ignoreCause({ log: true })),
    );
  }),
);
