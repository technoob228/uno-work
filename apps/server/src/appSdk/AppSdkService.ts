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
 * - Answers Settings → Apps: list, limit, revoke, task autonomy.
 */
import {
  APP_SDK_DEFAULT_CHAT_MODEL,
  APP_SDK_DEFAULT_PORT,
  type AppAiApp,
  type AppAiOverview,
  type AppAiUpdateInput,
  UNO_GATEWAY_BASE_URL,
} from "@t3tools/contracts";
import { Context, Duration, Effect, Layer, Schedule } from "effect";
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
import { makeAppTasks } from "./appTasks.ts";
import { type ModelPrice, parseModelPrices } from "./pricing.ts";
import { installSdkFiles } from "./sdkFiles.ts";

export const APP_API_PORT_ENV = "UNO_WORK_APP_API_PORT";
export const APP_API_GATEWAY_ENV = "UNO_WORK_APP_GATEWAY_URL";
const SYNC_EVERY = Duration.seconds(5);
const BRIDGE_CHECK_EVERY = Duration.seconds(30);
const PRICES_TTL_MS = 60 * 60_000;
export const PERSON_MAX_LIMIT_USD = 1000;

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

export function resolveAppApiPort(): number | null {
  const raw = process.env[APP_API_PORT_ENV]?.trim();
  if (raw === undefined || raw === "") return APP_SDK_DEFAULT_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/** IPv4 of the default docker bridge — the address `host-gateway` resolves to. */
export function dockerBridgeAddress(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | null {
  const docker0 = interfaces["docker0"] ?? [];
  return docker0.find((entry) => entry.family === "IPv4" && !entry.internal)?.address ?? null;
}

export function effectiveLimitUsd(stored: StoredApp, manifest: AppManifest | undefined): number {
  return stored.limitOverrideUsd ?? manifest?.ai?.limitUsd ?? 0;
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
        if (!manifest.ai) continue;
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
      // Manifest gone or no longer asks for AI: the token dies with it.
      for (const stored of store.all()) {
        if (next.get(stored.id)?.ai) continue;
        if (stored.tokenHash !== null) {
          await store.update(stored.id, (app) => {
            app.tokenHash = null;
          });
        }
      }
      for (const id of await listAppKeyIds(keysDir)) {
        if (!next.get(id)?.ai || store.get(id)?.revoked) await removeAppKey(keysDir, id);
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

    const callerFor = (stored: StoredApp): AppApiCaller | null => {
      const manifest = manifests.get(stored.id);
      if (!manifest?.ai || stored.revoked) return null;
      return {
        appId: stored.id,
        appName: manifest.name,
        chat: manifest.ai.chat,
        tasks: manifest.ai.tasks,
        limitUsd: effectiveLimitUsd(stored, manifest),
        spentUsd: stored.spentUsd,
        manifestCwd: manifest.cwd,
        taskToolsCap: stored.taskToolsCap,
      };
    };

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
    };

    const toApp = (stored: StoredApp, manifest: AppManifest | undefined): AppAiApp => {
      const limitUsd = effectiveLimitUsd(stored, manifest);
      return {
        id: stored.id,
        name: manifest?.name ?? stored.id,
        icon: manifest?.icon ?? null,
        chat: manifest?.ai?.chat ?? false,
        tasks: manifest?.ai?.tasks ?? false,
        status: stored.revoked ? "revoked" : stored.spentUsd >= limitUsd ? "over-limit" : "active",
        limitUsd,
        limitSetByPerson: stored.limitOverrideUsd !== null,
        spentUsd: Math.round(stored.spentUsd * 1e4) / 1e4,
        requests: stored.requests,
        tasksStarted: stored.tasksStarted,
        taskToolsCap: stored.taskToolsCap,
        lastUsedAt: stored.lastUsedAt,
        keyDir: displayManifestDir(appKeyDir(keysDir, stored.id), home),
      };
    };

    const overview: AppSdkServiceShape["overview"] = Effect.gen(function* () {
      yield* Effect.promise(() => sync());
      const current = yield* readSettings;
      const key = yield* gatewayKey.harnessKey().pipe(Effect.orElseSucceed(() => ""));
      const apps = store
        .all()
        .filter((stored) => manifests.get(stored.id)?.ai || stored.revoked)
        .filter((stored) => manifests.has(stored.id))
        .map((stored) => toApp(stored, manifests.get(stored.id)))
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
      } satisfies AppAiOverview;
    });

    const update: AppSdkServiceShape["update"] = (input) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => sync());
        if (!manifests.has(input.appId) || !store.get(input.appId)) {
          return yield* Effect.fail(
            new AppSdkUpdateError("That app isn't on this computer anymore."),
          );
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
        yield* Effect.promise(() =>
          store.update(input.appId, (app) => {
            if (input.limitUsd !== undefined) {
              app.limitOverrideUsd =
                input.limitUsd === null ? null : Math.round(input.limitUsd * 100) / 100;
            }
            if (input.taskToolsCap !== undefined) app.taskToolsCap = input.taskToolsCap;
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
          const address = dockerBridgeAddress();
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
