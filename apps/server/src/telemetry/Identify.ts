/**
 * The id Uno Work usage events carry: a random UUID made once per
 * installation and kept in `<stateDir>/install-id`.
 *
 * Nothing else on the machine is read for it. The upstream T3 Code version of
 * this file hashed account ids out of Codex's and Claude Code's own login
 * files and sent them to T3's PostHog; Uno Work never reads other tools' files
 * for telemetry (TELEMETRY.md, `noThirdPartyTelemetry.test.ts`).
 *
 * @module telemetry/Identify
 */
import { Effect, FileSystem, Random } from "effect";

import { ServerConfig } from "../config.ts";

const INSTALL_ID_PATTERN = /^[0-9a-f-]{36}$/u;

/** The installation id, created on first use; null when the state dir is not writable. */
export const getTelemetryInstallId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { installIdPath } = yield* ServerConfig;

  const existing = yield* fileSystem.readFileString(installIdPath).pipe(
    Effect.map((text) => text.trim()),
    Effect.orElseSucceed(() => ""),
  );
  if (INSTALL_ID_PATTERN.test(existing)) return existing;

  const created = yield* Random.nextUUIDv4;
  yield* fileSystem.writeFileString(installIdPath, created);
  return created;
}).pipe(
  Effect.tapError((error) => Effect.logWarning("telemetry: no install id", { cause: error })),
  Effect.orElseSucceed((): string | null => null),
);
