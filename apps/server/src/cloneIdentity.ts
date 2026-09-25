import { Cause, Effect, Layer, Queue } from "effect";

import { SessionCredentialService } from "./auth/Services/SessionCredentialService.ts";
import { ServerConfig } from "./config.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";

/**
 * Clone identity rotation in place — the Uno Work half of the memory-snapshot
 * fast start (reports/day_2026-09-25/work-first-answer).
 *
 * A Work machine restored from an image's memory snapshot wakes up with the
 * daemon already running and warm (harness probes done, the Uno chat set up),
 * but with the identity of the warm-up VM: the cookie signing key and the
 * environment id are shared by every clone of the snapshot. Until now the
 * image's `uno-work-identity` unit deleted them and RESTARTED the daemon —
 * correct, but it threw away exactly the warmth the snapshot was for (~20 s of
 * probes and assistant setup on a 2-vCPU box, measured 25.09).
 *
 * Now the unit deletes the files and sends SIGUSR2 to the daemon's main
 * process; this layer rotates both in memory and on disk and revokes every
 * session issued under the old key. A daemon without this layer dies on
 * SIGUSR2 (Node's default) and systemd restarts it — the old behaviour, so
 * image and daemon versions can't combine into a clone that keeps the shared
 * key.
 *
 * SIGUSR2, not SIGHUP: a terminal hang-up must keep stopping a `uno-work
 * serve` started by hand. Installed only in web mode on Linux (the Work box).
 */
export const CLONE_IDENTITY_SIGNAL = "SIGUSR2";

export const rotateCloneIdentity = Effect.gen(function* () {
  const sessions = yield* SessionCredentialService;
  const environment = yield* ServerEnvironment;
  if (sessions.rotateSigningKey) {
    yield* sessions.rotateSigningKey;
  }
  if (environment.rotateEnvironmentId) {
    yield* environment.rotateEnvironmentId;
  }
  yield* Effect.logInfo("clone identity rotated in place (no daemon restart)");
});

export const CloneIdentityRotationLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    if (serverConfig.mode !== "web" || process.platform !== "linux") {
      return;
    }
    const sessions = yield* SessionCredentialService;
    const environment = yield* ServerEnvironment;
    const rotate = rotateCloneIdentity.pipe(
      Effect.provideService(SessionCredentialService, sessions),
      Effect.provideService(ServerEnvironment, environment),
      Effect.catchCause((cause) =>
        Effect.logError("clone identity rotation failed").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        ),
      ),
    );
    const signals = yield* Queue.unbounded<void>();
    const onSignal = () => {
      Queue.offerUnsafe(signals, undefined);
    };
    process.on(CLONE_IDENTITY_SIGNAL, onSignal);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        process.off(CLONE_IDENTITY_SIGNAL, onSignal);
      }),
    );
    yield* Queue.take(signals).pipe(
      Effect.flatMap(() => rotate),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
