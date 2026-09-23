/**
 * AppSdkService — "the AI of this computer" for apps on it (docs/app-sdk.md).
 *
 * - Watches `~/.uno/apps/*.json`. An app whose manifest has an `"ai"` block
 *   gets its own token (`~/.uno/app-keys/<id>/`, only a hash is kept here);
 *   an app whose manifest or `ai` block disappears loses it.
 * - Serves the App API on its own listener: 127.0.0.1 and the docker bridge
 *   (docker0), never on the daemon's public address. Containers reach it at
 *   `host.docker.internal` with `extra_hosts: host-gateway`.
 * - Forwards chat / transcription to the Uno AI gateway with the machine's AI
 *   key, and keeps a per-app ledger against the app's limit.
 * - Starts app tasks as Work chats (`appTasks.ts`).
 * - Gives an app that asks for `"storage"` its own folder in the account's
 *   cloud (`appStorage.ts`), through the machine's console token.
 * - Answers Settings → Apps: list, limit, revoke, task autonomy.
 */
import {
  APP_SDK_DEFAULT_CHAT_MODEL,
  APP_SDK_DEFAULT_PORT,
  type AppAiApp,
  type AppAiOverview,
  type AppAiUpdateInput,
  type AppStorageInfo,
  UNO_GATEWAY_BASE_URL,
} from "@t3tools/contracts";
import { Context, Duration, Effect, Layer, Schedule } from "effect";
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { ServerConfig } from "../config.ts";
import { readManifestDir, type AppManifest } from "../machineApps/appManifest.ts";
import { displayManifestDir, resolveManifestDir } from "../machineApps/manifestDir.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { selectAutoBootstrapModelSelection } from "../provider/autoBootstrapModelSelection.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { UnoGatewayKey } from "../unoGatewayKey.ts";
import { type StoredApp, hashAppToken, newAppToken, openAppAiStore } from "./appAiStore.ts";
import { type AppApiCaller, type AppApiCore, makeAppApiHandler } from "./appApiHttp.ts";
import {
  type AppKeyEndpoints,
  appKeyDir,
  listAppKeyIds,
  readAppKeyToken,
  removeAppKey,
  resolveAppKeysDir,
  writeAppKey,
} from "./appKeys.ts";
import { resolveAppApiPort } from "./appApiPort.ts";
import { makeAppTasks } from "./appTasks.ts";
import {
  AppStorageError,
  GB,
  appFolder,
  appStorageComputerKey,
  makeAppStorage,
} from "./appStorage.ts";
import { type ModelPrice, parseModelPrices } from "./pricing.ts";
import { installSdkFiles } from "./sdkFiles.ts";

export const APP_API_GATEWAY_ENV = "UNO_WORK_APP_GATEWAY_URL";
const SYNC_EVERY = Duration.seconds(5);
const BRIDGE_CHECK_EVERY = Duration.seconds(30);
const PRICES_TTL_MS = 60 * 60_000;
export const PERSON_MAX_LIMIT_USD = 1000;
export const PERSON_MAX_STORAGE_GB = 10_000;

export interface AppSdkServiceShape {
  readonly overview: Effect.Effect<AppAiOverview>;
  readonly update: (input: AppAiUpdateInput) => Effect.Effect<AppAiOverview, AppSdkUpdateError>;
}

export class AppSdkUpdateError extends Error {
  readonly _tag = "AppSdkUpdateError";
}

export class AppSdkService extends Context.Service<AppSdkService, AppSdkServiceShape>()(
  "t3/appSdk/AppSdkService",
) {}

/** `ip -4 -o addr show dev docker0` → `172.17.0.1`. */
export function parseIpAddrShow(output: string): string | null {
  return /\binet\s+(\d{1,3}(?:\.\d{1,3}){3})\//.exec(output)?.[1] ?? null;
}

/**
 * IPv4 of the default docker bridge — the address `host-gateway` resolves to.
 * `os.networkInterfaces()` hides an interface without carrier, and docker0
 * has none until the first container starts, so `ip` is asked as well: the
 * address can be bound while the bridge is down, and then the first container
 * finds the App API already there.
 */
export async function dockerBridgeAddress(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): Promise<string | null> {
  const docker0 = interfaces["docker0"] ?? [];
  const found = docker0.find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
  if (found) return found;
  if (process.platform !== "linux") return null;
  return new Promise((resolve) => {
    execFile(
      "ip",
      ["-4", "-o", "addr", "show", "dev", "docker0"],
      { timeout: 3_000 },
      (error, stdout) => resolve(error ? null : parseIpAddrShow(String(stdout))),
    );
  });
}

export function effectiveLimitUsd(stored: StoredApp, manifest: AppManifest | undefined): number {
  return stored.limitOverrideUsd ?? manifest?.ai?.limitUsd ?? 0;
}

export function effectiveStorageLimitBytes(
  stored: StoredApp,
  manifest: AppManifest | undefined,
): number {
  const gb = stored.storageLimitOverrideGb ?? manifest?.storage?.limitGb ?? 0;
  return Math.round(gb * GB);
}

/** An app gets a token when its manifest asks for AI or cloud storage. */
export function wantsAppToken(manifest: AppManifest | undefined): boolean {
  return Boolean(manifest?.ai || manifest?.storage);
}

export const makeAppSdkService = (
  options: {
    readonly home?: string;
    readonly manifestDir?: string;
    readonly keysDir?: string;
    readonly storePath?: string;
    readonly port?: number | null;
    readonly gatewayBaseUrl?: string;
    /** Tests turn the listener, watcher and background passes off. */
    readonly background?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const gatewayKey = yield* UnoGatewayKey;
    const engine = yield* OrchestrationEngineService;
    const projections = yield* ProjectionSnapshotQuery;
    const providerRegistry = yield* ProviderRegistry;
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);

    const home = options.home ?? os.homedir();
    const manifestDir = options.manifestDir ?? resolveManifestDir(home);
    const keysDir = options.keysDir ?? resolveAppKeysDir(home);
    const port = options.port === undefined ? resolveAppApiPort() : options.port;
    const gatewayBaseUrl = (
      options.gatewayBaseUrl ??
      process.env[APP_API_GATEWAY_ENV]?.trim() ??
      UNO_GATEWAY_BASE_URL
    ).replace(/\/+$/, "");
    const store = yield* Effect.promise(() =>
      openAppAiStore(options.storePath ?? path.join(config.stateDir, "app-ai.json")),
    );

    let manifests = new Map<string, AppManifest>();
    let listening: string | null = null;
    let bridgeAddress: string | null = null;

    const endpoints = (): AppKeyEndpoints => ({
      url: `http://127.0.0.1:${port ?? APP_SDK_DEFAULT_PORT}`,
      dockerUrl: `http://host.docker.internal:${port ?? APP_SDK_DEFAULT_PORT}`,
    });

    const readSettings = settings.getSettings.pipe(Effect.orElseSucceed(() => null));

    /** Issue, keep or withdraw tokens so they match the manifests on disk. */
    let syncing: Promise<void> | null = null;
    const syncOnce = async () => {
      const scan = await readManifestDir({ manifestDir, home });
      const next = new Map(scan.manifests.map((m) => [m.id, m]));
      manifests = next;
      for (const manifest of next.values()) {
        if (!wantsAppToken(manifest)) continue;
        const stored = store.ensure(manifest.id);
        if (stored.revoked) {
          if (stored.tokenHash !== null) {
            await store.update(manifest.id, (app) => {
              app.tokenHash = null;
            });
          }
          await removeAppKey(keysDir, manifest.id);
          continue;
        }
        const onDisk = await readAppKeyToken(keysDir, manifest.id);
        if (onDisk !== null && stored.tokenHash === hashAppToken(onDisk)) continue;
        const token = newAppToken();
        await writeAppKey(keysDir, manifest.id, token, endpoints());
        await store.update(manifest.id, (app) => {
          app.tokenHash = hashAppToken(token);
          app.tokenIssuedAt = new Date().toISOString();
        });
      }
      // Manifest gone or no longer asks for AI or storage: the token dies with it.
      for (const stored of store.all()) {
        if (wantsAppToken(next.get(stored.id))) continue;
        if (stored.tokenHash !== null) {
          await store.update(stored.id, (app) => {
            app.tokenHash = null;
          });
        }
      }
      for (const id of await listAppKeyIds(keysDir)) {
        if (!wantsAppToken(next.get(id)) || store.get(id)?.revoked) {
          await removeAppKey(keysDir, id);
        }
      }
    };
    const sync = () => {
      if (!syncing) {
        syncing = syncOnce()
          .catch(() => undefined)
          .finally(() => {
            syncing = null;
          });
      }
      return syncing;
    };

    /** `computer-<box>` (or `local-<id>` off Uno computers) — see appStorage.ts. */
    const computerKey = async () => {
      const current = await runPromise(readSettings);
      return appStorageComputerKey(current?.uno.boxId ?? null, await store.localComputerId());
    };
    const folderOf = (stored: StoredApp, key: string) =>
      appFolder(stored.id, stored.storageScope === "computer" ? key : null);

    const callerFor = async (stored: StoredApp): Promise<AppApiCaller | null> => {
      const manifest = manifests.get(stored.id);
      if (!manifest || !wantsAppToken(manifest) || stored.revoked) return null;
      return {
        appId: stored.id,
        appName: manifest.name,
        chat: manifest.ai?.chat ?? false,
        tasks: manifest.ai?.tasks ?? false,
        limitUsd: effectiveLimitUsd(stored, manifest),
        spentUsd: stored.spentUsd,
        manifestCwd: manifest.cwd,
        taskToolsCap: stored.taskToolsCap,
        storage: manifest.storage
          ? {
              limitBytes: effectiveStorageLimitBytes(stored, manifest),
              folder: folderOf(stored, await computerKey()),
            }
          : null,
      };
    };

    // The machine's own console token (work-machine token, storage:*); the
    // account key only on machines linked the old way.
    const appStorage = makeAppStorage({
      token: () =>
        runPromise(
          readSettings.pipe(
            Effect.map((current) =>
              current ? current.uno.boxToken?.trim() || current.uno.apiKey.trim() : "",
            ),
          ),
        ),
    });

    let pricesCache: { at: number; prices: ReadonlyMap<string, ModelPrice> } | null = null;

    const tasks = makeAppTasks({
      engine,
      projections,
      getProviders: providerRegistry.getProviders,
      getTaskModelSelection: readSettings.pipe(
        Effect.map((current) => current?.appsAi.taskModelSelection ?? null),
      ),
      home,
    });

    const core: AppApiCore = {
      home,
      authenticate: async (token) => {
        const stored = store.findByTokenHash(hashAppToken(token));
        return stored ? callerFor(stored) : null;
      },
      gateway: async () => {
        const key = await runPromise(gatewayKey.harnessKey());
        return key.length > 0 ? { baseUrl: gatewayBaseUrl, key } : null;
      },
      defaults: async () => {
        const current = await runPromise(readSettings);
        const providers = await runPromise(providerRegistry.getProviders);
        const task =
          current?.appsAi.taskModelSelection ?? selectAutoBootstrapModelSelection(providers);
        return {
          chatModel:
            current?.appsAi.chatModel && current.appsAi.chatModel.length > 0
              ? current.appsAi.chatModel
              : APP_SDK_DEFAULT_CHAT_MODEL,
          taskHarness: task?.instanceId ?? null,
        };
      },
      prices: async () => {
        if (pricesCache && Date.now() - pricesCache.at < PRICES_TTL_MS) return pricesCache.prices;
        const gateway = await core.gateway();
        if (!gateway) return new Map();
        const response = await fetch(`${gateway.baseUrl}/models`, {
          headers: { authorization: `Bearer ${gateway.key}` },
          signal: AbortSignal.timeout(15_000),
        });
        const prices = response.ok ? parseModelPrices(await response.json()) : new Map();
        pricesCache = { at: Date.now(), prices };
        return prices;
      },
      charge: (appId, usd) => store.addSpend(appId, usd),
      createTask: async (caller, body) => {
        const outcome = await runPromise(tasks.createTask(caller, body));
        if (outcome.task) await store.addTask(caller.appId, outcome.task);
        return outcome;
      },
      findTask: (appId, taskId) => store.get(appId)?.tasks.find((task) => task.id === taskId),
      listTasks: (appId) => store.get(appId)?.tasks ?? [],
      viewTask: (task) => runPromise(tasks.viewTask(task)),
      taskDetail: async (task) => {
        const detail = await runPromise(tasks.readDetail(task));
        if (detail._tag === "None") return null;
        return {
          messages: detail.value.messages.map((m) => ({ id: m.id, role: m.role, text: m.text })),
          activities: detail.value.activities.map((a) => ({
            id: a.id,
            tone: a.tone,
            kind: a.kind,
            summary: a.summary,
          })),
        };
      },
      stopTask: (caller, task) => runPromise(tasks.stopTask(caller, task)),
      storage: appStorage,
    };

    let storageBucketId: number | null = null;
    const storageInfo = (
      stored: StoredApp,
      manifest: AppManifest | undefined,
      key: string,
    ): AppStorageInfo | null => {
      if (!manifest?.storage) return null;
      const folder = folderOf(stored, key);
      const usage = appStorage.cachedUsage(folder);
      return {
        limitBytes: effectiveStorageLimitBytes(stored, manifest),
        limitSetByPerson: stored.storageLimitOverrideGb !== null,
        usedBytes: usage?.usedBytes ?? null,
        files: usage?.files ?? null,
        bucketId: storageBucketId,
        prefix: folder,
        scope: stored.storageScope,
      };
    };

    /** Measure storage apps in the background, so Settings never waits on S3. */
    let measuring: Promise<void> | null = null;
    const measureStorage = (folders: ReadonlyArray<string>) => {
      if (measuring || folders.length === 0) return;
      measuring = (async () => {
        storageBucketId = await appStorage.bucketId();
        for (const folder of folders) await appStorage.usage(folder).catch(() => undefined);
      })().finally(() => {
        measuring = null;
      });
    };

    const toApp = (stored: StoredApp, manifest: AppManifest | undefined, key: string): AppAiApp => {
      const limitUsd = effectiveLimitUsd(stored, manifest);
      return {
        id: stored.id,
        name: manifest?.name ?? stored.id,
        icon: manifest?.icon ?? null,
        chat: manifest?.ai?.chat ?? false,
        tasks: manifest?.ai?.tasks ?? false,
        status: stored.revoked
          ? "revoked"
          : manifest?.ai && stored.spentUsd >= limitUsd
            ? "over-limit"
            : "active",
        limitUsd,
        limitSetByPerson: stored.limitOverrideUsd !== null,
        spentUsd: Math.round(stored.spentUsd * 1e6) / 1e6,
        requests: stored.requests,
        tasksStarted: stored.tasksStarted,
        taskToolsCap: stored.taskToolsCap,
        lastUsedAt: stored.lastUsedAt,
        keyDir: displayManifestDir(appKeyDir(keysDir, stored.id), home),
        storage: storageInfo(stored, manifest, key),
      };
    };

    const overview: AppSdkServiceShape["overview"] = Effect.gen(function* () {
      yield* Effect.promise(() => sync());
      const current = yield* readSettings;
      const key = yield* gatewayKey.harnessKey().pipe(Effect.orElseSucceed(() => ""));
      const providers = yield* providerRegistry.getProviders;
      const thisComputer = yield* Effect.promise(computerKey);
      const listed = store
        .all()
        .filter((stored) => wantsAppToken(manifests.get(stored.id)) || stored.revoked)
        .filter((stored) => manifests.has(stored.id));
      measureStorage(
        listed
          .filter((stored) => manifests.get(stored.id)?.storage)
          .map((stored) => folderOf(stored, thisComputer)),
      );
      const apps = listed
        .map((stored) => toApp(stored, manifests.get(stored.id), thisComputer))
        .toSorted((a, b) => a.name.localeCompare(b.name));
      return {
        apps,
        apiUrl: listening,
        dockerUrl: bridgeAddress !== null ? endpoints().dockerUrl : null,
        gatewayConnected: key.length > 0,
        chatModel:
          current?.appsAi.chatModel && current.appsAi.chatModel.length > 0
            ? current.appsAi.chatModel
            : APP_SDK_DEFAULT_CHAT_MODEL,
        taskModelSelection: current?.appsAi.taskModelSelection ?? null,
        taskModelDefault: selectAutoBootstrapModelSelection(providers),
      } satisfies AppAiOverview;
    });

    const update: AppSdkServiceShape["update"] = (input) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => sync());
        const known = store.get(input.appId);
        // Deleting an app's cloud files comes right after the app is removed,
        // when its manifest may be gone already: the stored entry is enough.
        const onlyDeletesFiles = Object.keys(input).every(
          (field) => field === "appId" || field === "deleteCloudFiles",
        );
        if (!known || (!manifests.has(input.appId) && !onlyDeletesFiles)) {
          return yield* Effect.fail(
            new AppSdkUpdateError("That app isn't on this computer anymore."),
          );
        }
        if (input.deleteCloudFiles === true) {
          const folder = folderOf(known, yield* Effect.promise(computerKey));
          const deleted = yield* Effect.tryPromise({
            try: () => appStorage.deleteFolder(folder),
            catch: (cause) =>
              new AppSdkUpdateError(
                `Couldn't delete the app's files in the cloud: ${
                  cause instanceof AppStorageError ? cause.message : String(cause)
                }`,
              ),
          });
          yield* Effect.logInfo("app sdk: app's cloud files deleted by the person", {
            appId: input.appId,
            folder,
            deleted,
          });
        }
        if (
          input.limitUsd !== undefined &&
          input.limitUsd !== null &&
          !(
            Number.isFinite(input.limitUsd) &&
            input.limitUsd >= 0 &&
            input.limitUsd <= PERSON_MAX_LIMIT_USD
          )
        ) {
          return yield* Effect.fail(
            new AppSdkUpdateError(`The limit must be between $0 and $${PERSON_MAX_LIMIT_USD}.`),
          );
        }
        if (
          input.storageLimitGb !== undefined &&
          input.storageLimitGb !== null &&
          !(
            Number.isFinite(input.storageLimitGb) &&
            input.storageLimitGb > 0 &&
            input.storageLimitGb <= PERSON_MAX_STORAGE_GB
          )
        ) {
          return yield* Effect.fail(
            new AppSdkUpdateError(
              `The cloud limit must be more than 0 and at most ${PERSON_MAX_STORAGE_GB} GB.`,
            ),
          );
        }
        yield* Effect.promise(() =>
          store.update(input.appId, (app) => {
            if (input.limitUsd !== undefined) {
              app.limitOverrideUsd =
                input.limitUsd === null ? null : Math.round(input.limitUsd * 100) / 100;
            }
            if (input.taskToolsCap !== undefined) app.taskToolsCap = input.taskToolsCap;
            if (input.storageLimitGb !== undefined) {
              app.storageLimitOverrideGb =
                input.storageLimitGb === null ? null : Math.round(input.storageLimitGb * 100) / 100;
            }
            if (input.storageScope !== undefined) app.storageScope = input.storageScope;
            if (input.resetSpent === true) app.spentUsd = 0;
            if (input.revoked === true) {
              app.revoked = true;
              app.tokenHash = null;
            } else if (input.revoked === false) {
              app.revoked = false;
            }
          }),
        );
        if (input.revoked === true) {
          yield* Effect.promise(() => removeAppKey(keysDir, input.appId));
        }
        yield* Effect.logInfo("app sdk: app updated by the person", { ...input });
        return yield* overview;
      });

    if (options.background !== false) {
      yield* Effect.promise(() => installSdkFiles(home)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("app sdk: could not install SDK files", { cause }),
        ),
      );
      yield* Effect.promise(() => sync());

      // Instant pick-up of a new manifest (the agent writes it, then starts the app).
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          try {
            return watch(manifestDir, { persistent: false }, () => void sync());
          } catch {
            return null;
          }
        }),
        (watcher) => Effect.sync(() => watcher?.close()),
      );
      yield* Effect.forkScoped(
        Effect.promise(() => sync()).pipe(Effect.repeat(Schedule.spaced(SYNC_EVERY))),
      );

      if (port !== null) {
        const handler = makeAppApiHandler(core);
        const servers = new Map<string, http.Server>();
        const listen = (host: string) =>
          new Promise<boolean>((resolve) => {
            const server = http.createServer((req, res) => void handler(req, res));
            server.once("error", () => resolve(false));
            server.listen(port, host, () => {
              servers.set(host, server);
              resolve(true);
            });
          });
        const loopbackOk = yield* Effect.promise(() => listen("127.0.0.1"));
        if (loopbackOk) {
          listening = `http://127.0.0.1:${port}`;
          yield* Effect.logInfo("app sdk: App API listening", { url: listening });
        } else {
          yield* Effect.logWarning("app sdk: App API port is busy — apps can't use AI", { port });
        }
        // docker0 appears when docker starts, maybe after the daemon.
        const checkBridge = Effect.promise(async () => {
          const address = await dockerBridgeAddress();
          if (address === bridgeAddress) return;
          if (bridgeAddress !== null) {
            servers.get(bridgeAddress)?.close();
            servers.delete(bridgeAddress);
          }
          bridgeAddress = address !== null && (await listen(address)) ? address : null;
        });
        yield* Effect.forkScoped(
          checkBridge.pipe(Effect.repeat(Schedule.spaced(BRIDGE_CHECK_EVERY))),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const server of servers.values()) server.close();
          }),
        );
      }
    }

    return { overview, update, core, sync } satisfies AppSdkServiceShape & {
      readonly core: AppApiCore;
      readonly sync: () => Promise<void>;
    };
  });

export const AppSdkServiceLive = Layer.effect(AppSdkService, makeAppSdkService());
