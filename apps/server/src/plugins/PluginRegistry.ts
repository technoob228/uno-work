/**
 * PluginRegistry — loads and watches declarative plugin manifests.
 *
 * Two forms live side by side in `ServerConfig.pluginsDir`:
 * - flat `<id>.json` — hooks/crons only;
 * - directory `<id>/plugin.json` — same manifest plus arbitrary assets next to
 *   it (that is where a `panel` gets its HTML/JS/data files).
 *
 * The registry keeps the parsed set in memory, hot-reloads on any change (the
 * agent writing a file is the primary "install" path), and publishes
 * client-facing snapshots.
 *
 * Follows the `serverSettings.ts` pattern: Cache-free Ref state + PubSub +
 * Semaphore + debounced `FileSystem.watch`. `fs.watch` is not recursive, so
 * watchers are re-attached after every reload: one on `pluginsDir` plus one per
 * plugin directory (non-recursive — asset writes deeper inside do not need a
 * reload).
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
import { resolvePluginPanelLocation } from "./panelPaths.ts";

const RECENT_RUNS_LIMIT = 20;
const WATCH_DEBOUNCE_MS = 150;

/** Manifest file name inside a plugin directory. */
export const PLUGIN_DIRECTORY_MANIFEST_FILE = "plugin.json";

export interface LoadedPlugin {
  readonly id: string;
  /** `<id>.json` for flat manifests, `<id>/plugin.json` for directories. */
  readonly fileName: string;
  readonly filePath: string;
  /** Plugin directory — only for the directory form (panels live there). */
  readonly directoryPath: string | undefined;
  /** Present only when the file parsed and validated. */
  readonly manifest: PluginManifest | undefined;
  readonly error: string | undefined;
}

/** One discovered manifest before it is read/parsed. */
interface PluginEntry {
  readonly id: string;
  readonly fileName: string;
  readonly filePath: string;
  readonly directoryPath: string | undefined;
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

/** Directories to watch for manifest edits (the parent watch is not recursive). */
function pluginDirectoriesOf(plugins: ReadonlyArray<LoadedPlugin>): ReadonlyArray<string> {
  return plugins
    .map((plugin) => plugin.directoryPath)
    .filter((directory): directory is string => directory !== undefined)
    .toSorted();
}

/**
 * Structural signature of the loaded set: crons write data files inside plugin
 * directories, and a watch event per write must not spam the UI with identical
 * snapshots.
 */
function pluginsSignature(plugins: ReadonlyArray<LoadedPlugin>): string {
  return JSON.stringify(
    plugins.map((plugin) => [
      plugin.id,
      plugin.fileName,
      plugin.error ?? null,
      plugin.manifest ?? null,
    ]),
  );
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
  // Вотчеры директорий живут в отдельном scope: он пересоздаётся при каждом
  // изменении набора плагин-директорий. Перевешивает их фибер-потребитель
  // сигналов, а не сами вотчеры, — иначе фибер закрывал бы scope, в котором
  // работает, и прерывал сам себя.
  const watchSignals = yield* PubSub.unbounded<void>();
  const watchTargetsScopeRef = yield* Ref.make<Scope.Closeable | undefined>(undefined);
  const watchedDirectoriesRef = yield* Ref.make<ReadonlyArray<string>>([]);
  const signatureRef = yield* Ref.make<string | null>(null);
  yield* Effect.addFinalizer(() =>
    Ref.get(watchTargetsScopeRef).pipe(
      Effect.flatMap((scope) => (scope ? Scope.close(scope, Exit.void) : Effect.void)),
    ),
  );

  const toPluginsError = (detail: string, cause?: unknown) =>
    new PluginsError({ detail, ...(cause !== undefined ? { cause } : {}) });

  const statType = (candidate: string) =>
    fs.stat(candidate).pipe(
      Effect.map((info) => info.type as string),
      Effect.orElseSucceed(() => null),
    );

  /** `panel` needs the file on disk, so validation is effectful. */
  const validatePanel = (entry: PluginEntry, manifest: PluginManifest) =>
    Effect.gen(function* () {
      const panel = manifest.panel;
      if (panel === undefined) return undefined;
      if (entry.directoryPath === undefined) {
        return `panel: only directory plugins (${entry.id}/${PLUGIN_DIRECTORY_MANIFEST_FILE}) can ship a panel`;
      }
      if (panel.title.trim().length === 0) {
        return `panel: "title" must not be empty`;
      }
      const location = resolvePluginPanelLocation({
        pluginDir: entry.directoryPath,
        panelPath: panel.path,
      });
      if (location === null) {
        return `panel: "path" must be a relative path inside the plugin directory (got "${panel.path}")`;
      }
      const type = yield* statType(location.entryFilePath);
      if (type !== "File") {
        return `panel: file "${panel.path}" not found in the plugin directory`;
      }
      return undefined;
    });

  const loadPluginEntry = (entry: PluginEntry): Effect.Effect<LoadedPlugin> =>
    Effect.gen(function* () {
      const invalid = (error: string) =>
        ({ ...entry, manifest: undefined, error }) satisfies LoadedPlugin;
      const raw = yield* fs.readFileString(entry.filePath);
      const decoded = Schema.decodeUnknownExit(PluginManifestJson)(raw);
      if (decoded._tag === "Failure") {
        return invalid(`failed to parse manifest: ${Cause.squash(decoded.cause)}`);
      }
      const validationError =
        validateManifest(decoded.value) ?? (yield* validatePanel(entry, decoded.value));
      if (validationError !== undefined) {
        return invalid(validationError);
      }
      return { ...entry, manifest: decoded.value, error: undefined } satisfies LoadedPlugin;
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          ...entry,
          manifest: undefined,
          error: `failed to read plugin file: ${String(cause)}`,
        } satisfies LoadedPlugin),
      ),
    );

  /**
   * Discovers both forms. A directory without `plugin.json` is not a plugin and
   * is ignored silently (agents keep scratch folders next to manifests).
   */
  const discoverPluginEntries = Effect.gen(function* () {
    const entries = yield* fs
      .readDirectory(pluginsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const discovered: PluginEntry[] = [];
    for (const entry of entries.filter((name) => !name.startsWith(".")).toSorted()) {
      const entryPath = pathService.join(pluginsDir, entry);
      const type = yield* statType(entryPath);
      if (type === "Directory") {
        const manifestPath = pathService.join(entryPath, PLUGIN_DIRECTORY_MANIFEST_FILE);
        const manifestType = yield* statType(manifestPath);
        if (manifestType !== "File") continue;
        discovered.push({
          id: entry,
          fileName: `${entry}/${PLUGIN_DIRECTORY_MANIFEST_FILE}`,
          filePath: manifestPath,
          directoryPath: entryPath,
        });
        continue;
      }
      if (type === "File" && entry.endsWith(".json")) {
        discovered.push({
          id: entry.slice(0, -".json".length),
          fileName: entry,
          filePath: entryPath,
          directoryPath: undefined,
        });
      }
    }
    return discovered as ReadonlyArray<PluginEntry>;
  });

  const loadPluginsFromDisk = Effect.gen(function* () {
    const entries = yield* discoverPluginEntries;
    const byId = new Map<string, PluginEntry[]>();
    for (const entry of entries) {
      const bucket = byId.get(entry.id);
      if (bucket) bucket.push(entry);
      else byId.set(entry.id, [entry]);
    }

    const plugins: LoadedPlugin[] = [];
    for (const [id, bucket] of [...byId.entries()].toSorted(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      // Файл и директория с одним id — неоднозначность: обе формы объявляем
      // невалидными, иначе выбор «победителя» зависел бы от порядка чтения.
      if (bucket.length > 1) {
        const names = bucket.map((entry) => entry.fileName).join(" and ");
        for (const entry of bucket) {
          plugins.push({
            ...entry,
            manifest: undefined,
            error: `duplicate plugin id "${id}": ${names}`,
          });
        }
        continue;
      }
      plugins.push(yield* loadPluginEntry(bucket[0]!));
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
          ...(manifest?.panel !== undefined ? { panel: { title: manifest.panel.title } } : {}),
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

  /**
   * Re-attaches directory watchers: the plugins dir plus one per plugin
   * directory (non-recursive on purpose — asset writes deeper inside do not
   * change the manifest set). Called only from the reload consumer fiber.
   */
  const attachWatchers = (directories: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const previous = yield* Ref.getAndSet(watchTargetsScopeRef, undefined);
      if (previous !== undefined) {
        yield* Scope.close(previous, Exit.void);
      }
      const scope = yield* Scope.make("sequential");
      yield* Ref.set(watchTargetsScopeRef, scope);
      yield* Ref.set(watchedDirectoriesRef, directories);
      for (const directory of [pluginsDir, ...directories]) {
        yield* Stream.runForEach(fs.watch(directory), () =>
          PubSub.publish(watchSignals, undefined),
        ).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));
      }
    });

  const reloadAndEmit = stateSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const plugins = yield* loadPluginsFromDisk;

      const directories = pluginDirectoriesOf(plugins);
      const watched = yield* Ref.get(watchedDirectoriesRef);
      if (
        watched.length !== directories.length ||
        watched.some((dir, i) => dir !== directories[i])
      ) {
        yield* attachWatchers(directories);
      }

      const signature = pluginsSignature(plugins);
      const previousSignature = yield* Ref.getAndSet(signatureRef, signature);
      if (previousSignature === signature) {
        // Ничего не изменилось (например, крон переписал data.json внутри
        // плагин-директории) — не будим подписчиков лишним снапшотом.
        return;
      }

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
    const debouncedEvents = Stream.fromPubSub(watchSignals).pipe(
      Stream.debounce(Duration.millis(WATCH_DEBOUNCE_MS)),
    );

    yield* Stream.runForEach(debouncedEvents, () => reloadSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );

    yield* attachWatchers([]);
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
          yield* Ref.set(signatureRef, pluginsSignature(reloaded));
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
