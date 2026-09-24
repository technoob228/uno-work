/**
 * MachineAppsService — the programs on this computer's desktop.
 *
 * Looks at the machine the daemon runs on (see `machineAppsScan.ts`), keeps
 * the answer warm with a background pass every 20 s, and performs the few
 * things a desktop does with a program: start it, stop it, show it on the
 * internet, hide it again — remove a docker container the person started
 * themselves (never the computer's own, never an App Store app's), remove an
 * app registered in `~/.uno/apps` (see `removeRegisteredApp.ts`), and take a
 * found program off the home screen ("Hide", `hiddenApps.ts`) without
 * touching it.
 *
 * "Show on the internet" is always a click. It asks the control plane for a
 * public TCP forward of the app's port with this machine's own key (the
 * narrow `work-machine` token when there is one), exactly like any other port
 * the user opens from the console — nothing is published by discovery itself.
 *
 * Actions never trust what the browser says about an app: the id is looked up
 * in a fresh scan, and only what the scan found (a container name, a user unit,
 * a pid that listens on the app's port) is acted on.
 */
import type {
  UnoComputerLocalMetrics,
  UnoMachineApp,
  UnoMachineAppActionInput,
  UnoMachineApps,
} from "@t3tools/contracts";
import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, truncateSync } from "node:fs";
import { readFile, rmdir, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Context, Duration, Effect, Layer, Schedule } from "effect";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { UnoBoxIdentity } from "../unoBoxIdentity.ts";
import { UnoCloudFetchError } from "../workspaceRegistry/UnoCloudService.ts";
import {
  NOT_LINKED_MESSAGE,
  composeProjectFor,
  computerKeyFor,
  humanizeControlPlaneError,
  parseAppCards,
} from "../workspaceRegistry/unoComputer.ts";
import {
  controlPlaneErrorStatus,
  fetchControlPlaneJson,
} from "../workspaceRegistry/unoCloudParse.ts";
import { resolveAppApiPort } from "../appSdk/appApiPort.ts";
import { appKeyDir, removeAppKey, resolveAppKeysDir } from "../appSdk/appKeys.ts";
import { CpuLoadWindow, type CpuTotals } from "../computerResources/cpuWindow.ts";
import { parseCpuTotals, parseVmStat } from "../computerResources/resourceParsers.ts";
import { readIconDataUrl, readManifestDir, type AppManifest } from "./appManifest.ts";
import { extractHtmlTitle, parseCgroupOwner } from "./discoveryParsers.ts";
import { openHiddenApps } from "./hiddenApps.ts";
import { displayManifestDir, resolveManifestDir } from "./manifestDir.ts";
import {
  APP_MARKER_ENV,
  codeFolderFor,
  pickAppProcesses,
  pickAppUnits,
  readProcessTable,
  readUserUnitFiles,
  removePaths,
  resolvedPath,
  stopProcesses,
  type CodeFolder,
  type ProcessInfo,
} from "./removeRegisteredApp.ts";
import {
  RESERVED_FORWARD_PORTS,
  parsePortForwards,
  publicationFor,
  readSystemd,
  scanMachineApps,
  type CommandResult,
  type HttpProbe,
  type MachineProbe,
  type PortForward,
  type ScannedApp,
} from "./machineAppsScan.ts";

const SCAN_TTL_MS = 4_000;
/**
 * systemd units are re-read at most this often by the regular refresh (a
 * Start/Stop or any fresh scan reads them at once). Asking systemd for every
 * unit is the costliest part of a scan — about half a second of processor —
 * and at the 5-second refresh it alone kept an idle computer at 10–20%.
 */
export const SYSTEMD_TTL_MS = 30_000;
const BACKGROUND_EVERY = Duration.seconds(20);
const HTTP_PROBE_TTL_MS = 60_000;
/** A port that didn't answer HTTP is asked again after this (a new port is asked at once). */
const HTTP_PROBE_NEGATIVE_TTL_MS = 30_000;
const HTTP_PROBE_TIMEOUT_MS = 1_200;
const CONTROL_PLANE_TTL_MS = 15_000;
const COMMAND_TIMEOUT_MS = 5_000;
const APP_LOG_MAX_BYTES = 5 * 1024 * 1024;
const AUTOSTART_DELAY = Duration.seconds(3);

export const PUBLISH_NOT_A_COMPUTER =
  "Only an Uno computer can show programs on the internet — this machine runs Uno Work on its own hardware.";

export interface MachineAppsServiceShape {
  readonly list: Effect.Effect<UnoMachineApps>;
  readonly action: (
    input: UnoMachineAppActionInput,
  ) => Effect.Effect<UnoMachineApps, UnoCloudFetchError>;
  readonly localMetrics: Effect.Effect<UnoComputerLocalMetrics>;
  /**
   * The last scan with what the daemon keeps for itself (listener pids,
   * container and unit names) — for the "what is using my computer" view,
   * never sent to the browser as is. At most a few seconds old.
   */
  readonly scanned: Effect.Effect<ReadonlyArray<ScannedApp>>;
}

export class MachineAppsService extends Context.Service<
  MachineAppsService,
  MachineAppsServiceShape
>()("t3/machineApps/MachineAppsService") {}

class ActionError extends Error {}

function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  // `systemctl --user` needs the user's runtime dir, which a system service lacks.
  if (!env["XDG_RUNTIME_DIR"] && typeof process.getuid === "function") {
    env["XDG_RUNTIME_DIR"] = `/run/user/${process.getuid()}`;
  }
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env },
      (error, stdout) => resolve({ ok: error === null, stdout: String(stdout ?? "") }),
    );
  });
}

async function readTextFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function probeHttpOnce(host: string, port: number): Promise<HttpProbe> {
  const response = await fetch(`http://${host}:${port}/`, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
    headers: { "User-Agent": "UnoWork-desktop/1 (app discovery)" },
  });
  let title: string | null = null;
  if ((response.headers.get("content-type") ?? "").includes("html")) {
    const reader = response.body?.getReader();
    let html = "";
    while (reader && html.length < 64 * 1024) {
      const chunk = await reader.read();
      if (chunk.done) break;
      html += new TextDecoder().decode(chunk.value);
      if (/<\/title>/i.test(html)) break;
    }
    await reader?.cancel().catch(() => undefined);
    title = extractHtmlTitle(html);
  } else {
    await response.body?.cancel().catch(() => undefined);
  }
  return { http: true, title };
}

/** Does something answer HTTP on this port? A garbage or silent answer is "no". */
export async function probeHttp(port: number): Promise<HttpProbe> {
  for (const host of ["127.0.0.1", "[::1]"]) {
    try {
      return await probeHttpOnce(host, port);
    } catch {
      // Next address, then give up.
    }
  }
  return { http: false, title: null };
}

/**
 * App SDK variables for an app whose manifest asks for AI: its id, and — once
 * the App SDK service has issued it — the API address and the app's own token
 * from `~/.uno/app-keys/<id>/env` (never another app's).
 */
export function appSdkEnvironment(manifest: Pick<AppManifest, "id" | "ai">, home: string) {
  if (!manifest.ai) return {};
  const env: Record<string, string> = { UNO_APP_ID: manifest.id };
  try {
    const text = readFileSync(path.join(resolveAppKeysDir(home), manifest.id, "env"), "utf8");
    for (const line of text.split("\n")) {
      const match = /^(UNO_APP_[A-Z_]+)=(.*)$/.exec(line.trim());
      if (match?.[1] && match[2] !== undefined) env[match[1]] = match[2];
    }
  } catch {
    // Not issued yet: the SDK waits for the key folder by itself.
  }
  return env;
}

/** The environment a user's app starts with: theirs, not the daemon's secrets. */
export function appEnvironment(home: string, port: number | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env["LANG"] ?? "C.UTF-8",
    TERM: "xterm-256color",
  };
  for (const key of ["USER", "LOGNAME", "SHELL", "TZ"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  if (port !== null) env["PORT"] = String(port);
  return env;
}

function startManifestCommand(manifest: AppManifest, manifestDir: string, home: string): void {
  if (!manifest.command) throw new ActionError("This app doesn't say how to start it.");
  mkdirSync(manifestDir, { recursive: true });
  const logPath = path.join(manifestDir, `${manifest.id}.log`);
  try {
    if (statSync(logPath).size > APP_LOG_MAX_BYTES) truncateSync(logPath, 0);
  } catch {
    // No log yet.
  }
  const fd = openSync(logPath, "a");
  try {
    const child = spawn("/bin/bash", ["-lc", manifest.command], {
      cwd: manifest.cwd ?? home,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: {
        ...appEnvironment(home, manifest.port),
        ...appSdkEnvironment(manifest, home),
        // So "Remove" finds it again, whatever it forks into.
        [APP_MARKER_ENV]: manifest.id,
      },
    });
    child.on("error", () => undefined);
    child.unref();
  } finally {
    closeSync(fd);
  }
}

/** A scanned app with what only the daemon knows: hidden, its code folder. */
interface KnownApp extends ScannedApp {
  readonly hidden: boolean;
  readonly code: (CodeFolder & { readonly display: string }) | null;
}

/** `~`, `~/projects/notes` — or the absolute path outside home. */
function displayInHome(dir: string, home: string): string {
  return dir === home ? "~" : displayManifestDir(dir, home);
}

function toPublic(
  app: KnownApp,
  forwards: ReadonlyArray<PortForward>,
  hostname: string | null,
): UnoMachineApp {
  const { control: _control, manifest: _manifest, code, ...rest } = app;
  return {
    ...rest,
    publication: publicationFor(app, forwards, hostname),
    ...(app.source === "manifest"
      ? {
          codeDir: code?.display ?? null,
          codeDirKeepReason: code?.keepReason ?? null,
        }
      : {}),
  };
}

interface CloudView {
  readonly boxId: number | null;
  readonly apiKey: string;
  readonly forwards: ReadonlyArray<PortForward>;
  readonly hostname: string | null;
  readonly blockedReason: string | null;
}

export const makeMachineAppsService = (
  options: {
    readonly probe?: Partial<MachineProbe>;
    readonly fetchJson?: (apiKey: string, path: string, init?: RequestInit) => Promise<unknown>;
    readonly manifestDir?: string;
    readonly home?: string;
    /** `~/.uno/app-keys` (App SDK tokens), deleted with a removed app. */
    readonly keysDir?: string;
    /** Where "Hide" is remembered; null = memory only. Defaults to the state folder. */
    readonly hiddenPath?: string | null;
    /** Tests: the processes of this machine (Linux `/proc`). */
    readonly processTable?: () => Promise<ReadonlyArray<ProcessInfo>>;
    /** Tests: stop these pids; returns the ones still alive. */
    readonly stopProcesses?: (pids: ReadonlyArray<number>) => Promise<number[]>;
    /** Tests turn the background pass and autostart off. */
    readonly background?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const identity = yield* UnoBoxIdentity;
    const home = options.home ?? os.homedir();
    const manifestDir = options.manifestDir ?? resolveManifestDir(home);
    const fetchJson = options.fetchJson ?? fetchControlPlaneJson;
    const keysDir = options.keysDir ?? resolveAppKeysDir(home);
    const hiddenApps = yield* Effect.promise(() =>
      openHiddenApps(
        options.hiddenPath !== undefined
          ? options.hiddenPath
          : config.stateDir
            ? path.join(config.stateDir, "machine-apps-hidden.json")
            : null,
      ),
    );
    const processTable = options.processTable ?? readProcessTable;
    const stopPids = options.stopProcesses ?? ((pids) => stopProcesses(pids));

    const httpCache = new Map<number, { at: number; result: HttpProbe }>();
    const probe: MachineProbe = {
      platform: process.platform,
      home,
      selfPid: process.pid,
      // The daemon's own ports: its web port and the App SDK's local API.
      selfPorts: new Set(
        [config.port, resolveAppApiPort()].filter((port): port is number => port !== null),
      ),
      run: runCommand,
      readFile: readTextFile,
      probeHttp: async (port) => {
        const cached = httpCache.get(port);
        const ttl = cached?.result.http ? HTTP_PROBE_TTL_MS : HTTP_PROBE_NEGATIVE_TTL_MS;
        if (cached && Date.now() - cached.at < ttl) return cached.result;
        const result = await probeHttp(port);
        httpCache.set(port, { at: Date.now(), result });
        return result;
      },
      ...options.probe,
    };

    let lastScan: { at: number; apps: KnownApp[]; warnings: string[] } | null = null;
    let inFlight: Promise<{ apps: KnownApp[]; warnings: string[] }> | null = null;

    /** Folders "also delete the code" must never reach. */
    const protectedDirs = [
      manifestDir,
      keysDir,
      path.join(home, ".uno"),
      ...(config.stateDir ? [config.stateDir] : []),
    ];

    /** Each manifest's code folder, symlinks resolved, judged against the others. */
    const codeFolders = async (manifests: ReadonlyArray<AppManifest>) => {
      const [realHome, realProtected, resolved] = await Promise.all([
        resolvedPath(home),
        Promise.all(protectedDirs.map(resolvedPath)),
        Promise.all(
          manifests.map(async (m) => ({
            id: m.id,
            name: m.name,
            cwd: m.cwd ? await resolvedPath(m.cwd) : null,
          })),
        ),
      ]);
      const out = new Map<string, (CodeFolder & { readonly display: string }) | null>();
      for (const m of resolved) {
        const folder = codeFolderFor(m, {
          home: realHome,
          protectedDirs: realProtected,
          others: resolved,
        });
        out.set(m.id, folder ? { ...folder, display: displayInHome(folder.path, realHome) } : null);
      }
      return out;
    };

    let unitsCache: { at: number; units: Awaited<ReturnType<typeof readSystemd>> } | null = null;
    const readUnitsCached = async (p: MachineProbe, fresh: boolean) => {
      if (!fresh && unitsCache && Date.now() - unitsCache.at < SYSTEMD_TTL_MS) {
        return unitsCache.units;
      }
      const units = await readSystemd(p);
      unitsCache = { at: Date.now(), units };
      return units;
    };

    const scanNow = async (fresh: boolean) => {
      const { manifests, warnings } = await readManifestDir({ manifestDir, home });
      const icons = new Map<string, string>();
      await Promise.all(
        manifests.map(async (m) => {
          if (!m.iconFile) return;
          const data = await readIconDataUrl(m.iconFile);
          if (data) icons.set(m.id, data);
        }),
      );
      const [scanned, code] = await Promise.all([
        scanMachineApps(probe, {
          manifests,
          manifestIcons: icons,
          readUnits: (p) => readUnitsCached(p, fresh),
        }),
        codeFolders(manifests),
      ]);
      const apps = scanned.map(
        (app): KnownApp =>
          app.source === "manifest" && app.manifest
            ? {
                ...app,
                // A registered app can be removed; an App Store app's own
                // manifest is refused at removal (it is removed from its card).
                canRemove: true,
                hidden: false,
                code: code.get(app.manifest.id) ?? null,
              }
            : { ...app, hidden: hiddenApps.has(app.id), code: null },
      );
      lastScan = { at: Date.now(), apps, warnings: [...warnings] };
      return lastScan;
    };

    const scan = (fresh = false) => {
      if (!fresh && lastScan && Date.now() - lastScan.at < SCAN_TTL_MS) {
        return Promise.resolve(lastScan);
      }
      if (inFlight) return inFlight;
      inFlight = scanNow(fresh).finally(() => {
        inFlight = null;
      });
      return inFlight;
    };

    let cloudCache: { at: number; view: CloudView } | null = null;

    const readCloud = Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
      const boxId = yield* identity.current;
      const apiKey = computerKeyFor(
        {
          accountKey: current?.uno.apiKey ?? "",
          boxToken: current?.uno.boxToken ?? "",
          ownBoxId: boxId,
        },
        boxId,
      );
      return { boxId, apiKey };
    });

    const cloudView = (fresh: boolean) =>
      Effect.gen(function* () {
        const { boxId, apiKey } = yield* readCloud;
        if (boxId === null) {
          return {
            boxId,
            apiKey,
            forwards: [],
            hostname: null,
            blockedReason: PUBLISH_NOT_A_COMPUTER,
          } satisfies CloudView;
        }
        if (apiKey.length === 0) {
          return { boxId, apiKey, forwards: [], hostname: null, blockedReason: NOT_LINKED_MESSAGE };
        }
        if (!fresh && cloudCache && Date.now() - cloudCache.at < CONTROL_PLANE_TTL_MS) {
          return cloudCache.view;
        }
        const view = yield* Effect.promise(async (): Promise<CloudView> => {
          const [boxResult, portsResult] = await Promise.allSettled([
            fetchJson(apiKey, `/api/v1/boxes/${boxId}`),
            fetchJson(apiKey, `/api/v1/boxes/${boxId}/ports`),
          ]);
          const box =
            boxResult.status === "fulfilled" && typeof boxResult.value === "object"
              ? (boxResult.value as Record<string, unknown>)
              : null;
          const hostname =
            typeof box?.["hostname"] === "string" && box["hostname"].length > 0
              ? box["hostname"]
              : typeof box?.["network_public_ip"] === "string"
                ? box["network_public_ip"]
                : null;
          return {
            boxId,
            apiKey,
            forwards:
              portsResult.status === "fulfilled" ? parsePortForwards(portsResult.value) : [],
            hostname,
            blockedReason: null,
          };
        });
        cloudCache = { at: Date.now(), view };
        return view;
      });

    const assemble = (
      scanned: { apps: KnownApp[]; warnings: string[] },
      cloud: CloudView,
    ): UnoMachineApps => ({
      apps: scanned.apps.map((app) => toPublic(app, cloud.forwards, cloud.hostname)),
      manifestDir: displayManifestDir(manifestDir, home),
      scannedAt: new Date().toISOString(),
      publishBlockedReason: cloud.blockedReason,
      warnings: scanned.warnings,
    });

    const list: MachineAppsServiceShape["list"] = Effect.gen(function* () {
      const scanned = yield* Effect.promise(() => scan());
      const cloud = yield* cloudView(false);
      return assemble(scanned, cloud);
    });

    const publish = async (app: ScannedApp, cloud: CloudView) => {
      if (cloud.blockedReason) throw new ActionError(cloud.blockedReason);
      const wanted: Array<{ port: number; protocol: "tcp" | "udp" }> = [
        ...(app.port !== null ? [{ port: app.port, protocol: "tcp" as const }] : []),
        ...app.udpPorts.map((port) => ({ port, protocol: "udp" as const })),
      ].filter((p) => !RESERVED_FORWARD_PORTS.has(p.port));
      if (wanted.length === 0) throw new ActionError("This app has no port to show.");
      if (app.port !== null && RESERVED_FORWARD_PORTS.has(app.port)) {
        throw new ActionError("That port belongs to the computer itself.");
      }
      if (app.loopbackOnly) {
        throw new ActionError(
          "This app only listens inside the computer (127.0.0.1), so the internet can't reach it. Ask Uno to make it listen on all addresses (0.0.0.0), then try again.",
        );
      }
      for (const { port, protocol } of wanted) {
        const existing = cloud.forwards.find(
          (f) => f.internalPort === port && f.protocol === protocol && f.state !== "deleting",
        );
        if (existing?.visibility === "public") continue;
        if (existing) {
          await fetchJson(cloud.apiKey, `/api/v1/boxes/${cloud.boxId}/ports/${existing.id}`, {
            method: "PUT",
            body: JSON.stringify({ visibility: "public" }),
          });
          continue;
        }
        await fetchJson(cloud.apiKey, `/api/v1/boxes/${cloud.boxId}/ports`, {
          method: "POST",
          body: JSON.stringify({ port, protocol, visibility: "public" }),
        });
      }
    };

    const unpublish = async (app: ScannedApp, cloud: CloudView) => {
      if (cloud.blockedReason) throw new ActionError(cloud.blockedReason);
      const publication = publicationFor(app, cloud.forwards, cloud.hostname);
      for (const forward of publication?.forwards ?? []) {
        if (RESERVED_FORWARD_PORTS.has(forward.internalPort)) continue;
        await fetchJson(cloud.apiKey, `/api/v1/boxes/${cloud.boxId}/ports/${forward.forwardId}`, {
          method: "DELETE",
        });
      }
    };

    const startApp = async (app: ScannedApp) => {
      if (!app.canStart) throw new ActionError("This app can't be started from here.");
      if (app.manifest?.command) {
        startManifestCommand(app.manifest, manifestDir, home);
        return;
      }
      const result =
        app.control.kind === "docker"
          ? await runCommand("docker", ["start", app.control.container], 60_000)
          : app.control.kind === "systemd" && app.control.user
            ? await runCommand("systemctl", ["--user", "start", app.control.unit], 30_000)
            : null;
      if (!result?.ok)
        throw new ActionError("The computer didn't start it. Try again in a moment.");
    };

    const stopApp = async (app: ScannedApp) => {
      if (!app.canStop) throw new ActionError("This app can't be stopped from here.");
      if (app.control.kind === "docker") {
        const result = await runCommand("docker", ["stop", app.control.container], 60_000);
        if (!result.ok) throw new ActionError("Docker didn't stop it.");
        return;
      }
      if (app.control.kind === "systemd" && app.control.user) {
        const result = await runCommand("systemctl", ["--user", "stop", app.control.unit], 30_000);
        if (!result.ok) throw new ActionError("The service didn't stop.");
        return;
      }
      if (app.control.kind === "process") {
        try {
          process.kill(app.control.pid, "SIGTERM");
        } catch {
          throw new ActionError("It belongs to another user, so only an admin can stop it.");
        }
        return;
      }
      throw new ActionError("This app can't be stopped from here.");
    };

    /**
     * Compose projects of the App Store apps on this computer. Asked fresh at
     * removal: a container of an App Store app is never removed from here
     * (its card does it, through Uno). Unknown (an older console, no key) is an
     * empty set — `uno-*` projects are refused by the scan itself.
     */
    const storeComposeProjects = async (cloud: CloudView): Promise<ReadonlySet<string>> => {
      if (cloud.boxId === null || cloud.apiKey.length === 0) return new Set();
      try {
        const cards = parseAppCards(
          await fetchJson(cloud.apiKey, `/api/v1/boxes/${cloud.boxId}/apps`),
        );
        const projects = new Set<string>();
        for (const card of cards.values()) {
          const project = card.composeProject ?? composeProjectFor(card.templateId);
          if (project) projects.add(project);
        }
        return projects;
      } catch {
        return new Set();
      }
    };

    /**
     * "Remove" of a program found on the machine: only a docker container the
     * person started themselves. The container goes (`docker rm -f`); its
     * volumes stay — no `-v` — so the data is still on the computer.
     */
    const removeContainer = async (app: ScannedApp, cloud: CloudView) => {
      if (app.source !== "docker" || app.control.kind !== "docker" || !app.canRemove) {
        throw new ActionError("This program can't be removed from here.");
      }
      if (app.composeProject && (await storeComposeProjects(cloud)).has(app.composeProject)) {
        throw new ActionError(
          "This is part of an app from the App Store — remove it from the app's own card.",
        );
      }
      // The same docker CLI the scan reads and Start/Stop use (`probe.run`), as
      // the daemon's own user — no sudo. No docker access → the scan finds no
      // containers, so there is nothing to remove either.
      const result = await probe.run("docker", ["rm", "-f", app.control.container], 120_000);
      if (!result.ok) {
        throw new ActionError("Docker didn't remove it. Try again in a moment.");
      }
    };

    /** The catalog ids of the App Store apps on this computer (fresh; empty when unknown). */
    const storeTemplateIds = async (cloud: CloudView): Promise<ReadonlySet<string>> => {
      if (cloud.boxId === null || cloud.apiKey.length === 0) return new Set();
      try {
        const cards = parseAppCards(
          await fetchJson(cloud.apiKey, `/api/v1/boxes/${cloud.boxId}/apps`),
        );
        return new Set(
          [...cards.values()].flatMap((card) => (card.templateId ? [card.templateId] : [])),
        );
      } catch {
        return new Set();
      }
    };

    /** The service a process runs in, when it is one of this user's units. */
    const ownerUnitOf = async (pid: number): Promise<string | null> => {
      if (probe.platform !== "linux") return null;
      const owner = parseCgroupOwner((await probe.readFile(`/proc/${pid}/cgroup`)) ?? "");
      return owner?.kind === "service" ? owner.unit : null;
    };

    const uid = typeof process.getuid === "function" ? process.getuid() : null;

    /**
     * "Remove" of an app registered in the apps folder (what an AI built here):
     * stop what runs it, delete its manifest, icon, log and App SDK key, and —
     * only when asked — its code folder. See `removeRegisteredApp.ts`.
     */
    const removeRegistered = async (app: KnownApp, cloud: CloudView, deleteCode: boolean) => {
      const manifest = app.manifest;
      if (app.source !== "manifest" || !manifest) {
        throw new ActionError("This program can't be removed from here.");
      }
      if ((await storeTemplateIds(cloud)).has(manifest.id)) {
        throw new ActionError(
          "This app came from the App Store — remove it from the app's own card.",
        );
      }
      const code = app.code;
      if (deleteCode && code?.keepReason) {
        throw new ActionError(`Its code folder can't be deleted: ${code.keepReason}`);
      }
      const codeDir = code?.path ?? null;
      // Processes and units are matched by folder only when the folder is the
      // app's alone: a manifest whose cwd is home must not stop everything in home.
      const ownDir = code && code.keepReason === null ? code.path : null;
      const manifestPath = path.join(manifestDir, `${manifest.id}.json`);
      const listenerPid = app.control.kind === "process" ? app.control.pid : null;

      // 1. Units that run it: stopped and disabled first, or they'd restart it.
      const linux = probe.platform === "linux";
      const ownerUnit = listenerPid !== null ? await ownerUnitOf(listenerPid) : null;
      const units = linux
        ? pickAppUnits(await readUserUnitFiles(home), {
            appId: manifest.id,
            codeDir: ownDir,
            ownerUnits: ownerUnit ? [ownerUnit] : [],
            manifestPath,
          })
        : [];
      if (units.length > 0) {
        await probe.run(
          "systemctl",
          ["--user", "disable", "--now", ...units.map((u) => u.name)],
          60_000,
        );
      }
      if (app.control.kind === "docker") {
        await probe.run("docker", ["stop", app.control.container], 60_000);
      }

      // 2. Its processes.
      if (linux) {
        const table = await processTable();
        const listener = listenerPid !== null ? table.find((p) => p.pid === listenerPid) : null;
        if (listener && uid !== null && listener.uid !== null && listener.uid !== uid) {
          throw new ActionError(
            `${manifest.name} runs as another user, so Uno can't stop it. Stop it in the Terminal (with sudo), then remove it again.`,
          );
        }
        const pids = pickAppProcesses(table, {
          appId: manifest.id,
          selfPid: process.pid,
          uid,
          listenerPids: listenerPid !== null ? [listenerPid] : [],
          codeDir: ownDir,
        });
        const left = await stopPids(pids);
        if (left.length > 0) {
          throw new ActionError(
            `${manifest.name} didn't stop. Try again in a moment, or stop it in the Terminal.`,
          );
        }
      } else if (listenerPid !== null) {
        const left = await stopPids([listenerPid]);
        if (left.length > 0) throw new ActionError(`${manifest.name} didn't stop.`);
      }

      // 3. Its files. An icon file another manifest uses stays.
      const otherIcons = new Set(
        (lastScan?.apps ?? [])
          .filter((a) => a.manifest && a.manifest.id !== manifest.id && a.manifest.iconFile)
          .map((a) => a.manifest!.iconFile!),
      );
      const removed = await removePaths([
        ...units.map((u) => ({ path: u.path })),
        { path: manifestPath },
        ...(manifest.iconFile && !otherIcons.has(manifest.iconFile)
          ? [{ path: manifest.iconFile }]
          : []),
        { path: path.join(manifestDir, `${manifest.id}.log`) },
      ]);
      if (units.length > 0) {
        await probe.run("systemctl", ["--user", "daemon-reload"], 30_000);
        await probe.run("systemctl", ["--user", "reset-failed"], 10_000);
      }
      // The token is withdrawn by the App SDK when it sees the manifest gone
      // (at once, through its folder watcher); the files go now.
      await removeAppKey(keysDir, manifest.id).catch(() => undefined);
      // The app is gone, so its (now empty) key folder too; anything else in it stays.
      await rmdir(appKeyDir(keysDir, manifest.id)).catch(() => undefined);
      if (removed.errors.some((e) => e.startsWith(manifestPath))) {
        throw new ActionError(
          `Couldn't delete ${manifest.name}'s file in ${displayManifestDir(manifestDir, home)}. Try again, or delete ${manifest.id}.json there.`,
        );
      }

      // 4. The code, only when asked, and only a folder that is the app's alone.
      if (deleteCode && codeDir) {
        // Judged again against the apps registered now (one may have appeared meanwhile).
        const again = (
          await codeFolders([...(await remainingManifests()), { ...manifest, cwd: codeDir }])
        ).get(manifest.id);
        if (again?.keepReason) {
          throw new ActionError(`Its code folder was kept: ${again.keepReason}`);
        }
        const result = await removePaths([{ path: codeDir, recursive: true }]);
        if (result.errors.length > 0) {
          throw new ActionError(
            `${manifest.name} is removed, but some of its code in ${code?.display ?? codeDir} couldn't be deleted (files of another user?).`,
          );
        }
      }
    };

    /** The other manifests right now (the removed one is already gone). */
    const remainingManifests = async (): Promise<AppManifest[]> => [
      ...(await readManifestDir({ manifestDir, home })).manifests,
    ];

    /** Waits a little for the change to show, so the answer is not stale. */
    const settle = async (appId: string, done: (app: ScannedApp | undefined) => boolean) => {
      for (let i = 0; i < 12; i++) {
        const scanned = await scan(true);
        if (done(scanned.apps.find((a) => a.id === appId))) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };

    const action: MachineAppsServiceShape["action"] = (input) =>
      Effect.gen(function* () {
        // Start / stop / remove act on processes: look again. Show / hide only touch the
        // cloud, so the last scan (seconds old) is enough.
        const lifecycle =
          input.action === "start" || input.action === "stop" || input.action === "remove";
        if (input.action === "hide" || input.action === "unhide") {
          // Anything the scan knows may be hidden, even if it's gone meanwhile when shown again.
          const known = yield* Effect.promise(() => scan());
          if (input.action === "hide" && !known.apps.some((a) => a.id === input.appId)) {
            return yield* new UnoCloudFetchError({
              message: "That program isn't on this computer anymore.",
            });
          }
          yield* Effect.promise(() => hiddenApps.set(input.appId, input.action === "hide"));
          const fresh = yield* Effect.promise(() => scan(true));
          return assemble(fresh, yield* cloudView(false));
        }
        const scanned = yield* Effect.promise(() => scan(lifecycle));
        const app = scanned.apps.find((a) => a.id === input.appId);
        if (!app) {
          return yield* new UnoCloudFetchError({
            message: "That program isn't on this computer anymore.",
          });
        }
        const cloud = yield* cloudView(true);
        yield* Effect.tryPromise({
          try: async () => {
            switch (input.action) {
              case "start":
                await startApp(app);
                await settle(app.id, (a) => a?.status === "running");
                return;
              case "stop":
                await stopApp(app);
                await settle(app.id, (a) => a === undefined || a.status !== "running");
                return;
              case "publish":
                await publish(app, cloud);
                return;
              case "unpublish":
                await unpublish(app, cloud);
                return;
              case "hide":
              case "unhide":
                return;
              case "remove":
                if (app.source === "manifest") {
                  await removeRegistered(app, cloud, input.deleteCode === true);
                } else {
                  await removeContainer(app, cloud);
                }
                // A published port has nothing behind it anymore: take it down too.
                if (!cloud.blockedReason && publicationFor(app, cloud.forwards, cloud.hostname)) {
                  await unpublish(app, cloud).catch(() => undefined);
                }
                await settle(app.id, (a) => a === undefined);
                return;
            }
          },
          catch: (cause) =>
            new UnoCloudFetchError({
              message:
                cause instanceof ActionError
                  ? cause.message
                  : controlPlaneErrorStatus(cause) === 409 &&
                      String((cause as Error).message).includes("NO_EXTERNAL_PORT")
                    ? "There are no free public ports left for this computer right now."
                    : humanizeControlPlaneError(cause),
            }),
        });
        const fresh = yield* Effect.promise(() => scan(lifecycle));
        const freshCloud = yield* cloudView(true);
        return assemble(fresh, freshCloud);
      });

    // The share over at least the last ~15 s, whoever asks and how often
    // (see cpuWindow.ts) — not since the previous caller's read.
    const cpuWindow = new CpuLoadWindow();
    const cpuTotals = async (): Promise<CpuTotals | null> => {
      if (process.platform === "linux") {
        const parsed = parseCpuTotals((await readTextFile("/proc/stat")) ?? "");
        if (parsed) return parsed;
      }
      let idle = 0;
      let total = 0;
      for (const { times: t } of os.cpus()) {
        idle += t.idle;
        total += t.user + t.nice + t.sys + t.idle + t.irq;
      }
      return total > 0 ? { idle, total } : null;
    };
    void cpuTotals().then((t) => cpuWindow.sample(Date.now(), t));
    const cpuPercent = async (): Promise<number | null> =>
      cpuWindow.sample(Date.now(), await cpuTotals());

    const memoryMb = async () => {
      const totalMb = os.totalmem() / 1024 / 1024;
      if (process.platform === "darwin") {
        // os.freemem() on a Mac leaves out the file cache it gives back on demand,
        // so memory would always look full: count it the way Activity Monitor does.
        const vm = await runCommand("vm_stat", [], 3_000);
        const parsed = vm.ok ? parseVmStat(vm.stdout, os.totalmem()) : null;
        if (parsed) return { usedMb: parsed.usedMb, totalMb };
      }
      const meminfo = process.platform === "linux" ? await readTextFile("/proc/meminfo") : null;
      const available = meminfo ? /MemAvailable:\s+(\d+) kB/.exec(meminfo) : null;
      const availableMb = available ? Number(available[1]) / 1024 : os.freemem() / 1024 / 1024;
      return { usedMb: Math.max(0, totalMb - availableMb), totalMb };
    };

    const localMetrics: MachineAppsServiceShape["localMetrics"] = Effect.promise(async () => {
      const [cpuPct, mem, disk] = await Promise.all([
        cpuPercent(),
        memoryMb(),
        statfs(home).catch(() => null),
      ]);
      const gb = (blocks: number | bigint, size: number | bigint) =>
        (Number(blocks) * Number(size)) / 1024 ** 3;
      return {
        hostname: os.hostname(),
        platform: process.platform,
        cpuPct,
        cpuCount: os.cpus().length,
        memUsedMb: Math.round(mem.usedMb),
        memTotalMb: Math.round(mem.totalMb),
        diskUsedGb: disk ? gb(Number(disk.blocks) - Number(disk.bfree), disk.bsize) : null,
        diskTotalGb: disk ? gb(disk.blocks, disk.bsize) : null,
        uptimeS: Math.round(os.uptime()),
      } satisfies UnoComputerLocalMetrics;
    });

    /**
     * Apps registered with a command and a port come back when the computer
     * does (a cold boot, a wake from an archived snapshot): once, at start.
     */
    const autostart = Effect.promise(async () => {
      const scanned = await scan(true);
      for (const app of scanned.apps) {
        if (app.source !== "manifest" || !app.manifest?.autostart || !app.manifest.command)
          continue;
        if (app.manifest.port === null || app.status !== "stopped") continue;
        try {
          startManifestCommand(app.manifest, manifestDir, home);
        } catch {
          // One app failing to start is not the daemon's problem.
        }
      }
    });

    if (options.background !== false) {
      yield* Effect.forkScoped(
        Effect.sleep(AUTOSTART_DELAY).pipe(
          Effect.andThen(autostart),
          Effect.catchCause(() => Effect.void),
        ),
      );
      yield* Effect.forkScoped(
        Effect.promise(() => scan(true)).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.repeat(Schedule.spaced(BACKGROUND_EVERY)),
        ),
      );
    }

    const scanned: MachineAppsServiceShape["scanned"] = Effect.promise(() => scan()).pipe(
      Effect.map((result) => result.apps),
    );

    return { list, action, localMetrics, scanned } satisfies MachineAppsServiceShape;
  });

export const MachineAppsServiceLive = Layer.effect(MachineAppsService, makeMachineAppsService());
