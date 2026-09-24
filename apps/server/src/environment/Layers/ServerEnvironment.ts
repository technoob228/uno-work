import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, Random } from "effect";
import * as OS from "node:os";

import { ServerConfig } from "../../config.ts";
import { UnoBoxIdentity } from "../../unoBoxIdentity.ts";
import { ServerEnvironment, type ServerEnvironmentShape } from "../Services/ServerEnvironment.ts";
import packageJson from "../../../package.json" with { type: "json" };
import { resolveMachineKind } from "../machineKind.ts";
import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

function platformOs(): ExecutionEnvironmentDescriptor["platform"]["os"] {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "unknown";
  }
}

function platformArch(): ExecutionEnvironmentDescriptor["platform"]["arch"] {
  switch (process.arch) {
    case "arm64":
      return "arm64";
    case "x64":
      return "x64";
    default:
      return "other";
  }
}

export const makeServerEnvironment = Effect.fn("makeServerEnvironment")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const unoBoxIdentity = yield* UnoBoxIdentity;

  const readPersistedEnvironmentId = Effect.gen(function* () {
    const exists = yield* fileSystem
      .exists(serverConfig.environmentIdPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return null;
    }

    const raw = yield* fileSystem
      .readFileString(serverConfig.environmentIdPath)
      .pipe(Effect.map((value) => value.trim()));

    return raw.length > 0 ? raw : null;
  });

  const persistEnvironmentId = (value: string) =>
    fileSystem.writeFileString(serverConfig.environmentIdPath, `${value}\n`);

  const environmentIdRaw = yield* Effect.gen(function* () {
    const persisted = yield* readPersistedEnvironmentId;
    if (persisted) {
      return persisted;
    }

    const generated = yield* Random.nextUUIDv4;
    yield* persistEnvironmentId(generated);
    return generated;
  });

  const environmentId = EnvironmentId.make(environmentIdRaw);
  const cwdBaseName = path.basename(serverConfig.cwd).trim();
  const label = yield* resolveServerEnvironmentLabel({
    cwdBaseName,
  });

  const base = {
    environmentId,
    label,
    platform: {
      os: platformOs(),
      arch: platformArch(),
    },
    serverVersion: packageJson.version,
    capabilities: {
      repositoryIdentity: true,
      threadSnooze: true,
      threadSettlement: true,
      agentThreads: true,
      threadContinueDirect: true,
      assistantChat: true,
      assistantLlm: true,
    },
  } satisfies Omit<ExecutionEnvironmentDescriptor, "machineKind" | "unoBoxId">;
  const hostname = OS.hostname();

  // Built per call: the box id can arrive after startup (control-plane probe),
  // and the descriptor must say "Uno box" from that moment on.
  const getDescriptor = Effect.map(
    unoBoxIdentity.current,
    (unoBoxId): ExecutionEnvironmentDescriptor => ({
      ...base,
      ...resolveMachineKind({
        mode: serverConfig.mode,
        platform: process.platform,
        hostname,
        unoBoxId,
      }),
    }),
  );

  return {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor,
  } satisfies ServerEnvironmentShape;
});

export const ServerEnvironmentLive = Layer.effect(ServerEnvironment, makeServerEnvironment());
