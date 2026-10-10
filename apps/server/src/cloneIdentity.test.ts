import { expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { SessionCredentialService } from "./auth/Services/SessionCredentialService.ts";
import { onCloneIdentityRotated, rotateCloneIdentity } from "./cloneIdentity.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";

it.effect("rotates the signing key and the environment id together", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* rotateCloneIdentity.pipe(
      Effect.provideService(SessionCredentialService, {
        rotateSigningKey: Effect.sync(() => {
          calls.push("signing-key");
        }),
      } as unknown as SessionCredentialService["Service"]),
      Effect.provideService(ServerEnvironment, {
        rotateEnvironmentId: Effect.sync(() => {
          calls.push("environment-id");
        }),
      } as unknown as ServerEnvironment["Service"]),
    );
    expect(calls).toEqual(["signing-key", "environment-id"]);
  }),
);

it.effect("tolerates services without rotation support (older test doubles)", () =>
  Effect.gen(function* () {
    yield* rotateCloneIdentity.pipe(
      Effect.provideService(SessionCredentialService, {} as SessionCredentialService["Service"]),
      Effect.provideService(ServerEnvironment, {} as ServerEnvironment["Service"]),
    );
  }),
);

it.effect("rotates the environment id even when the key could not be rotated", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const exit = yield* Effect.exit(
      rotateCloneIdentity.pipe(
        Effect.provideService(SessionCredentialService, {
          rotateSigningKey: Effect.fail(new Error("secrets/ is gone")),
        } as unknown as SessionCredentialService["Service"]),
        Effect.provideService(ServerEnvironment, {
          rotateEnvironmentId: Effect.sync(() => {
            calls.push("environment-id");
          }),
        } as unknown as ServerEnvironment["Service"]),
      ),
    );
    expect(calls).toEqual(["environment-id"]);
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it.effect("tells listeners after the rotation: this daemon is a new computer now", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const rotate = rotateCloneIdentity.pipe(
      Effect.provideService(SessionCredentialService, {
        rotateSigningKey: Effect.sync(() => {
          calls.push("signing-key");
        }),
      } as unknown as SessionCredentialService["Service"]),
      Effect.provideService(ServerEnvironment, {
        rotateEnvironmentId: Effect.sync(() => {
          calls.push("environment-id");
        }),
      } as unknown as ServerEnvironment["Service"]),
    );
    // A listener's trouble is not the rotation's.
    const stopBroken = onCloneIdentityRotated(() => {
      throw new Error("listener");
    });
    const stop = onCloneIdentityRotated(() => {
      calls.push("listener");
    });
    yield* rotate;
    expect(calls).toEqual(["signing-key", "environment-id", "listener"]);
    stop();
    stopBroken();
    yield* rotate;
    expect(calls.filter((call) => call === "listener")).toHaveLength(1);
  }),
);
