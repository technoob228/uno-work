import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, Random, Ref } from "effect";
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

  // Ref, not const: a memory-snapshot clone gets its own id in place
  // (rotateEnvironmentId) instead of a daemon restart — see cloneIdentity.ts.
  const environmentIdRef = yield* Ref.make(EnvironmentId.make(environmentIdRaw));
  const cwdBaseName = path.basename(serverConfig.cwd).trim();
  const startupLabel = yield* resolveServerEnvironmentLabel({
    cwdBaseName,
  });
  // Имя машины на клоне из memory-снапшота: демон стартовал на warm-VM
  // (hostname img-N-warm), а своё имя клон получает от гостевого агента уже
  // после restore. Без перечитывания интерфейс звал компьютер «img-177-warm»
  // (26.09). Перечитываем только когда hostname сменился — resolve запускает
  // hostnamectl, делать это на каждый запрос дорого.
  const labelRef = yield* Ref.make({ hostname: OS.hostname(), label: startupLabel });
  const currentLabel = Effect.gen(function* () {
    const hostname = OS.hostname();
    const cached = yield* Ref.get(labelRef);
    if (cached.hostname === hostname) {
      return cached.label;
    }
    const label = yield* resolveServerEnvironmentLabel({ cwdBaseName, hostname }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.orElseSucceed(() => cached.label),
    );
    yield* Ref.set(labelRef, { hostname, label });
    return label;
  });

  const base = {
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
      assistantConversations: true,
    },
  } satisfies Omit<
    ExecutionEnvironmentDescriptor,
    "machineKind" | "unoBoxId" | "environmentId" | "label"
  >;

  // Built per call: the box id can arrive after startup (control-plane probe),
  // and the descriptor must say "Uno box" from that moment on.
  // The hostname is read per call too: a clone restored from a memory
  // snapshot gets its name from the guest agent AFTER the daemon is running.
  const getDescriptor = Effect.gen(function* () {
    const unoBoxId = yield* unoBoxIdentity.current;
    const environmentId = yield* Ref.get(environmentIdRef);
    const label = yield* currentLabel;
    return {
      ...base,
      label,
      environmentId,
      ...resolveMachineKind({
        mode: serverConfig.mode,
        platform: process.platform,
        hostname: OS.hostname(),
        unoBoxId,
      }),
    } satisfies ExecutionEnvironmentDescriptor;
  });

  const rotateEnvironmentId = Effect.gen(function* () {
    const generated = yield* Random.nextUUIDv4;
    yield* persistEnvironmentId(generated).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("environment id not persisted").pipe(Effect.annotateLogs({ cause })),
      ),
    );
    yield* Ref.set(environmentIdRef, EnvironmentId.make(generated));
  });

  return {
    getEnvironmentId: Ref.get(environmentIdRef),
    getDescriptor,
    rotateEnvironmentId,
  } satisfies ServerEnvironmentShape;
});

export const ServerEnvironmentLive = Layer.effect(ServerEnvironment, makeServerEnvironment());
