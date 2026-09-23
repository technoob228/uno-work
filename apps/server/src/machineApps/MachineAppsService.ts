/**
 * MachineAppsService — the programs on this computer's desktop.
 *
 * Looks at the machine the daemon runs on (see `machineAppsScan.ts`), keeps
 * the answer warm with a background pass every 20 s, and performs the few
 * things a desktop does with a program: start it, stop it, show it on the
 * internet, hide it again.
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
import { closeSync, mkdirSync, openSync, statSync, truncateSync } from "node:fs";
import { readFile, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Context, Duration, Effect, Layer, Schedule } from "effect";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { UnoBoxIdentity } from "../unoBoxIdentity.ts";
import { UnoCloudFetchError } from "../workspaceRegistry/UnoCloudService.ts";
import {
  NOT_LINKED_MESSAGE,
  computerKeyFor,
  humanizeControlPlaneError,
} from "../workspaceRegistry/unoComputer.ts";
import {
  controlPlaneErrorStatus,
  fetchControlPlaneJson,
} from "../workspaceRegistry/unoCloudParse.ts";
import { parseVmStat } from "../computerResources/resourceParsers.ts";
import { readIconDataUrl, readManifestDir, type AppManifest } from "./appManifest.ts";
import { extractHtmlTitle } from "./discoveryParsers.ts";
import { displayManifestDir, resolveManifestDir } from "./manifestDir.ts";
import {
  RESERVED_FORWARD_PORTS,
  parsePortForwards,
  publicationFor,
  scanMachineApps,
  type CommandResult,
  type HttpProbe,
  type MachineProbe,
  type PortForward,
  type ScannedApp,
} from "./machineAppsScan.ts";

const SCAN_TTL_MS = 4_000;
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
      env: appEnvironment(home, manifest.port),
    });
    child.on("error", () => undefined);
    child.unref();
  } finally {
    closeSync(fd);
  }
}

function toPublic(
  app: ScannedApp,
  forwards: ReadonlyArray<PortForward>,
  hostname: string | null,
): UnoMachineApp {
  const { control: _control, manifest: _manifest, ...rest } = app;
  return { ...rest, publication: publicationFor(app, forwards, hostname) };
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

    const httpCache = new Map<number, { at: number; result: HttpProbe }>();
    const probe: MachineProbe = {
      platform: process.platform,
      home,
      selfPid: process.pid,
      selfPorts: new Set([config.port]),
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

    let lastScan: { at: number; apps: ScannedApp[]; warnings: string[] } | null = null;
    let inFlight: Promise<{ apps: ScannedApp[]; warnings: string[] }> | null = null;

    const scanNow = async () => {
      const { manifests, warnings } = await readManifestDir({ manifestDir, home });
      const icons = new Map<string, string>();
      await Promise.all(
        manifests.map(async (m) => {
          if (!m.iconFile) return;
          const data = await readIconDataUrl(m.iconFile);
          if (data) icons.set(m.id, data);
        }),
      );
      const apps = await scanMachineApps(probe, { manifests, manifestIcons: icons });
      lastScan = { at: Date.now(), apps, warnings: [...warnings] };
      return lastScan;
    };

    const scan = (fresh = false) => {
      if (!fresh && lastScan && Date.now() - lastScan.at < SCAN_TTL_MS) {
        return Promise.resolve(lastScan);
      }
      if (inFlight) return inFlight;
      inFlight = scanNow().finally(() => {
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
      scanned: { apps: ScannedApp[]; warnings: string[] },
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
        // Start / stop act on processes: look again. Show / hide only touch the
        // cloud, so the last scan (seconds old) is enough.
        const lifecycle = input.action === "start" || input.action === "stop";
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

    let cpuSample = os.cpus().map((c) => c.times);
    let cpuSampleAt = Date.now();
    const cpuPercent = async (): Promise<number | null> => {
      if (Date.now() - cpuSampleAt < 200) await new Promise((r) => setTimeout(r, 250));
      const now = os.cpus().map((c) => c.times);
      let idle = 0;
      let total = 0;
      now.forEach((t, i) => {
        const prev = cpuSample[i];
        if (!prev) return;
        const d = (k: keyof typeof t) => t[k] - prev[k];
        const all = d("user") + d("nice") + d("sys") + d("idle") + d("irq");
        idle += d("idle");
        total += all;
      });
      cpuSample = now;
      cpuSampleAt = Date.now();
      return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : null;
    };

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
