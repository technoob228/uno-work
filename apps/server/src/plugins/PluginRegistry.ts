/**
 * PluginRegistry — loads and watches declarative plugin manifests.
 *
 * Plugins are flat JSON files in `ServerConfig.pluginsDir` (one file = one
 * plugin, id = file name without `.json`). The registry keeps the parsed set
 * in memory, hot-reloads on any change in the directory (the agent writing a
 * file is the primary "install" path), and publishes client-facing snapshots.
 *
 * Follows the `serverSettings.ts` pattern: Cache-free Ref state + PubSub +
 * Semaphore + debounced `FileSystem.watch`.
 */
import {
  PluginManifest,
  PluginsError,
  type PluginsSnapshot,
  type ServerPlugin,
  type ServerPluginRun,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { parseCronExpression, parseEveryDuration } from "./cron.ts";

const RECENT_RUNS_LIMIT = 20;
const WATCH_DEBOUNCE_MS = 150;

export interface LoadedPlugin {
  readonly id: string;
  readonly fileName: string;
  readonly filePath: string;
  /** Present only when the file parsed and validated. */
  readonly manifest: PluginManifest | undefined;
  readonly error: string | undefined;
}

export function cronLabel(cron: PluginManifest["crons"][number]): string {
  if (cron.schedule !== undefined) return cron.schedule;
  if (cron.every !== undefined) return `every ${cron.every}`;
  return "invalid";
}

/** Validation beyond the schema: cron entries must be actually schedulable. */
function validateManifest(manifest: PluginManifest): string | undefined {
  for (const [index, cron] of manifest.crons.entries()) {
    const label = cron.id ?? `#${index + 1}`;
    if ((cron.schedule === undefined) === (cron.every === undefined)) {
      return `cron ${label}: exactly one of "schedule" or "every" must be set`;
    }
    if (cron.schedule !== undefined && parseCronExpression(cron.schedule) === undefined) {
      return `cron ${label}: invalid cron expression "${cron.schedule}"`;
    }
    if (cron.every !== undefined && parseEveryDuration(cron.every) === undefined) {
      return `cron ${label}: invalid interval "${cron.every}" (use e.g. "5m", "1h")`;
    }
  }
  for (const [index, hook] of manifest.hooks.entries()) {
    if (hook.on.trim().length === 0) {
      return `hook #${index + 1}: "on" must not be empty`;
    }
  }
  return undefined;
}

export interface PluginRegistryShape {
  /** Start the registry runtime and attach directory watching. */
  readonly start: Effect.Effect<void, PluginsError>;

  /** Await registry readiness. */
  readonly ready: Effect.Effect<void, PluginsError>;

  /** Loaded plugins including invalid ones (for the runtime and snapshots). */
  readonly getLoadedPlugins: Effect.Effect<ReadonlyArray<LoadedPlugin>>;

  /** Client-facing snapshot. */
  readonly getSnapshot: Effect.Effect<PluginsSnapshot>;

  /** Toggle `enabled` inside the plugin's JSON file. */
  readonly setPluginEnabled: (input: {
    readonly pluginId: string;
    readonly enabled: boolean;
  }) => Effect.Effect<PluginsSnapshot, PluginsError>;

  /** Record a hook/cron execution for the settings UI. */
  readonly recordRun: (pluginId: string, run: ServerPluginRun) => Effect.Effect<void>;

  /** Stream of snapshot changes (file edits, toggles, recorded runs). */
  readonly streamChanges: Stream.Stream<PluginsSnapshot>;
}

export class PluginRegistry extends Context.Service<PluginRegistry, PluginRegistryShape>()(
  "t3/plugins/PluginRegistry",
) {}

const PluginManifestJson = fromLenientJson(PluginManifest);

const makePluginRegistry = Effect.gen(function* () {
  const { pluginsDir } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const stateSemaphore = yield* Semaphore.make(1);
  const pluginsRef = yield* Ref.make<ReadonlyArray<LoadedPlugin>>([]);
  const runsRef = yield* Ref.make<ReadonlyMap<string, ReadonlyArray<ServerPluginRun>>>(new Map());
  const changesPubSub = yield* PubSub.unbounded<PluginsSnapshot>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, PluginsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const toPluginsError = (detail: string, cause?: unknown) =>
    new PluginsError({ detail, ...(cause !== undefined ? { cause } : {}) });

  const loadPluginFile = (fileName: string): Effect.Effect<LoadedPlugin> =>
    Effect.gen(function* () {
      const filePath = pathService.join(pluginsDir, fileName);
      const id = fileName.slice(0, -".json".length);
      const raw = yield* fs.readFileString(filePath);
      const decoded = Schema.decodeUnknownExit(PluginManifestJson)(raw);
      if (decoded._tag === "Failure") {
        return {
          id,
          fileName,
          filePath,
          manifest: undefined,
          error: `failed to parse manifest: ${Cause.squash(decoded.cause)}`,
        } satisfies LoadedPlugin;
      }
      const validationError = validateManifest(decoded.value);
      if (validationError !== undefined) {
        return {
          id,
          fileName,
          filePath,
          manifest: undefined,
          error: validationError,
        } satisfies LoadedPlugin;
      }
      return {
        id,
        fileName,
        filePath,
        manifest: decoded.value,
        error: undefined,
      } satisfies LoadedPlugin;
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          id: fileName.slice(0, -".json".length),
          fileName,
          filePath: pathService.join(pluginsDir, fileName),
          manifest: undefined,
          error: `failed to read plugin file: ${String(cause)}`,
        } satisfies LoadedPlugin),
      ),
    );

  const loadPluginsFromDisk = Effect.gen(function* () {
    const entries = yield* fs
      .readDirectory(pluginsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const manifestFiles = entries
      .filter((entry) => entry.endsWith(".json") && !entry.startsWith("."))
      .toSorted();
    const plugins: LoadedPlugin[] = [];
    for (const fileName of manifestFiles) {
      plugins.push(yield* loadPluginFile(fileName));
    }
    return plugins as ReadonlyArray<LoadedPlugin>;
  });

  const buildSnapshot = Effect.gen(function* () {
    const plugins = yield* Ref.get(pluginsRef);
    const runs = yield* Ref.get(runsRef);
    return {
      pluginsDir,
      plugins: plugins.map((plugin): ServerPlugin => {
        const manifest = plugin.manifest;
        return {
          id: plugin.id,
          fileName: plugin.fileName,
          name: manifest?.name ?? plugin.id,
          ...(manifest?.description !== undefined ? { description: manifest.description } : {}),
          ...(manifest?.version !== undefined ? { version: manifest.version } : {}),
          enabled: manifest?.enabled ?? false,
          valid: manifest !== undefined,
          ...(plugin.error !== undefined ? { error: plugin.error } : {}),
          hooks: manifest?.hooks.map((hook) => ({ on: hook.on })) ?? [],
          crons: manifest?.crons.map((cron) => ({ label: cronLabel(cron) })) ?? [],
          recentRuns: runs.get(plugin.id) ?? [],
        };
      }),
    } satisfies PluginsSnapshot;
  });

  const emitSnapshot = buildSnapshot.pipe(
    Effect.flatMap((snapshot) => PubSub.publish(changesPubSub, snapshot)),
    Effect.asVoid,
  );

  const reloadAndEmit = stateSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const plugins = yield* loadPluginsFromDisk;
      yield* Ref.set(pluginsRef, plugins);
      // Drop run history for deleted plugins so it doesn't resurrect on re-create.
      const ids = new Set(plugins.map((plugin) => plugin.id));
      yield* Ref.update(runsRef, (runs) => {
        const next = new Map<string, ReadonlyArray<ServerPluginRun>>();
        for (const [id, pluginRuns] of runs) {
          if (ids.has(id)) next.set(id, pluginRuns);
        }
        return next;
      });
      yield* emitSnapshot;
    }),
  );

  const startWatcher = Effect.gen(function* () {
    yield* fs
      .makeDirectory(pluginsDir, { recursive: true })
      .pipe(
        Effect.mapError((cause) => toPluginsError("failed to prepare plugins directory", cause)),
      );

    const reloadSafely = reloadAndEmit.pipe(Effect.ignoreCause({ log: true }));
    const debouncedEvents = fs
      .watch(pluginsDir)
      .pipe(Stream.debounce(Duration.millis(WATCH_DEBOUNCE_MS)));

    yield* Stream.runForEach(debouncedEvents, () => reloadSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* reloadAndEmit;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getLoadedPlugins: Ref.get(pluginsRef),
    getSnapshot: buildSnapshot,
    setPluginEnabled: ({ pluginId, enabled }) =>
      stateSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const plugins = yield* Ref.get(pluginsRef);
          const plugin = plugins.find((candidate) => candidate.id === pluginId);
          if (plugin === undefined) {
            return yield* toPluginsError(`plugin "${pluginId}" not found`);
          }
          const raw = yield* fs
            .readFileString(plugin.filePath)
            .pipe(
              Effect.mapError((cause) =>
                toPluginsError(`failed to read plugin "${pluginId}"`, cause),
              ),
            );
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (cause) {
            return yield* toPluginsError(
              `plugin "${pluginId}" is not valid JSON; fix the file before toggling it`,
              cause,
            );
          }
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return yield* toPluginsError(`plugin "${pluginId}" manifest must be a JSON object`);
          }
          const nextManifest = { ...(parsed as Record<string, unknown>), enabled };
          yield* writeFileStringAtomically({
            filePath: plugin.filePath,
            contents: `${JSON.stringify(nextManifest, null, 2)}\n`,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, pathService),
            Effect.mapError((cause) =>
              toPluginsError(`failed to write plugin "${pluginId}"`, cause),
            ),
          );
          const reloaded = yield* loadPluginsFromDisk;
          yield* Ref.set(pluginsRef, reloaded);
          const snapshot = yield* buildSnapshot;
          yield* PubSub.publish(changesPubSub, snapshot);
          return snapshot;
        }),
      ),
    recordRun: (pluginId, run) =>
      Effect.gen(function* () {
        yield* Ref.update(runsRef, (runs) => {
          const next = new Map(runs);
          const existing = next.get(pluginId) ?? [];
          next.set(pluginId, [run, ...existing].slice(0, RECENT_RUNS_LIMIT));
          return next;
        });
        yield* emitSnapshot;
      }),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies PluginRegistryShape;
});

export const PluginRegistryLive = Layer.effect(PluginRegistry, makePluginRegistry);
