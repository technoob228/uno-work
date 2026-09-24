/**
 * CustomHarnessFiles — live view of `~/.uno/harnesses/*.json` for the
 * instance registry and the Harnesses settings screen.
 *
 * The folder is polled (a few small files; `fs.watch` is unreliable across
 * editors that write via rename and across network/overlay filesystems):
 * whenever the parsed files or the stored secret values change, `changes`
 * emits the new envelope map and the registry reconciles — adding,
 * rebuilding or removing `harness-<id>` instances without touching others.
 *
 * @module provider/customHarness/CustomHarnessFiles
 */
import {
  CustomHarnessRpcError,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { validateHarnessEnvName } from "@t3tools/shared/customHarness";
import { Context, Duration, Effect, Layer, PubSub, Ref, Schedule, Stream } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { registerKnownSecret } from "../../secretRedaction.ts";
import { installHarnessGuide } from "./harnessGuide.ts";
import {
  harnessFileSecretName,
  harnessFileToInstanceConfig,
  type HarnessFilesScan,
  resolveHarnessesDir,
  scanHarnessFiles,
} from "./harnessFiles.ts";

const POLL_INTERVAL = Duration.seconds(3);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface CustomHarnessFilesState {
  readonly scan: HarnessFilesScan;
  /** instanceId → secret name → is a value stored. */
  readonly secretsSet: ReadonlyMap<string, ReadonlySet<string>>;
  readonly configs: Readonly<Record<string, ProviderInstanceConfig>>;
}

export interface CustomHarnessFilesShape {
  readonly dir: string;
  readonly current: Effect.Effect<CustomHarnessFilesState>;
  /** Emits the envelope map every time it changes. */
  readonly changes: Stream.Stream<Readonly<Record<string, ProviderInstanceConfig>>>;
  /** Re-read the folder now (after a secret change, a save, …). */
  readonly refresh: Effect.Effect<CustomHarnessFilesState>;
  readonly setSecret: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly name: string;
    readonly value: string;
  }) => Effect.Effect<void, CustomHarnessRpcError>;
}

export class CustomHarnessFiles extends Context.Service<
  CustomHarnessFiles,
  CustomHarnessFilesShape
>()("t3/provider/customHarness/CustomHarnessFiles") {}

const EMPTY_STATE: CustomHarnessFilesState = {
  scan: { harnesses: [], invalid: [] },
  secretsSet: new Map(),
  configs: {},
};

export const makeCustomHarnessFiles = (dir: string) =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;
    const stateRef = yield* Ref.make<CustomHarnessFilesState>(EMPTY_STATE);
    const fingerprintRef = yield* Ref.make("");
    const changesPubSub =
      yield* PubSub.unbounded<Readonly<Record<string, ProviderInstanceConfig>>>();

    const load = Effect.gen(function* () {
      const scan = yield* Effect.promise(() => scanHarnessFiles(dir));
      const configs: Record<string, ProviderInstanceConfig> = {};
      const secretsSet = new Map<string, Set<string>>();
      for (const harness of scan.harnesses) {
        const values = new Map<string, string>();
        const setNames = new Set<string>();
        for (const name of harness.secretEnv) {
          const stored = yield* secretStore
            .get(harnessFileSecretName(harness.instanceId, name))
            .pipe(Effect.orElseSucceed(() => null));
          if (stored && stored.length > 0) {
            const value = textDecoder.decode(stored);
            values.set(name, value);
            setNames.add(name);
            registerKnownSecret(value);
          }
        }
        secretsSet.set(harness.instanceId, setNames);
        configs[harness.instanceId] = harnessFileToInstanceConfig(harness, values);
      }
      return { scan, secretsSet, configs } satisfies CustomHarnessFilesState;
    });

    const refresh = Effect.gen(function* () {
      const next = yield* load;
      yield* Ref.set(stateRef, next);
      const fingerprint = JSON.stringify(next.configs);
      const previous = yield* Ref.getAndSet(fingerprintRef, fingerprint);
      if (previous !== fingerprint) {
        yield* PubSub.publish(changesPubSub, next.configs);
      }
      return next;
    });

    // The contract + example on disk for agents on this machine.
    yield* Effect.promise(() => installHarnessGuide().catch(() => undefined));
    yield* refresh;
    yield* refresh.pipe(
      Effect.catchCause((cause) => Effect.logWarning("custom harness scan failed", cause)),
      Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
      Effect.forkScoped,
    );

    const setSecret: CustomHarnessFilesShape["setSecret"] = (input) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        const harness = state.scan.harnesses.find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        if (!harness) {
          return yield* new CustomHarnessRpcError({
            code: "notFound",
            message: `No harness file for ${input.instanceId}.`,
          });
        }
        const name = validateHarnessEnvName(input.name);
        if (!name.ok || !harness.secretEnv.includes(name.value)) {
          return yield* new CustomHarnessRpcError({
            code: "invalid",
            message: `"${input.name}" is not listed in secretEnv of ${harness.filePath}.`,
          });
        }
        const key = harnessFileSecretName(harness.instanceId, name.value);
        const write =
          input.value.length === 0
            ? secretStore.remove(key)
            : secretStore.set(key, textEncoder.encode(input.value));
        yield* write.pipe(
          Effect.mapError(
            (cause) =>
              new CustomHarnessRpcError({
                code: "failed",
                message: `Could not store the value: ${cause.message}`,
              }),
          ),
        );
        yield* refresh;
      });

    return {
      dir,
      current: Ref.get(stateRef),
      changes: Stream.fromPubSub(changesPubSub),
      refresh,
      setSecret,
    } satisfies CustomHarnessFilesShape;
  });

export const CustomHarnessFilesLive = Layer.effect(
  CustomHarnessFiles,
  makeCustomHarnessFiles(resolveHarnessesDir()),
);
