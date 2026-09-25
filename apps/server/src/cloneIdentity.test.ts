import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { SessionCredentialService } from "./auth/Services/SessionCredentialService.ts";
import { rotateCloneIdentity } from "./cloneIdentity.ts";
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
