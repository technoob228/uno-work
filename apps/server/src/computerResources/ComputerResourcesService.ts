/**
 * ComputerResourcesService — "what is using my computer".
 *
 * Behind the processor / memory / disk / network tiles of "This computer":
 *
 *  - a ring buffer of the whole machine's load, one point every 5 s for the
 *    last 10 minutes, kept by the daemon so a graph is there the moment the
 *    screen opens;
 *  - a snapshot of every process, grouped the way a person thinks (see
 *    `resourceGroups.ts`), read from /proc on Linux and `ps` on a Mac;
 *  - what takes the disk: `du` of the home folder one level at a time, run
 *    niced in the background and cached (the daemon never waits on it for
 *    long), docker's own accounting, and a fixed list of caches that are safe
 *    to empty;
 *  - the few actions a person needs there: quit a process, stop / restart an
 *    app or container, empty a cache.
 *
 * Actions trust nothing from the browser but ids: every one looks the target
 * up again in a fresh read, and only this user's processes that are not Uno
 * Work itself (or what launched it) can be quit.
 */
import type {
  UnoComputerResources,
  UnoDiskCleanInput,
  UnoDiskCleanResult,
  UnoDiskCleanable,
  UnoDiskDockerUsage,
  UnoDiskEntry,
  UnoDiskUsage,
  UnoDiskUsageInput,
  UnoResourceActionInput,
  UnoResourceActionResult,
  UnoResourcesDiskVolume,
  UnoResourcesDockerAccess,
  UnoResourcesPoint,
} from "@t3tools/contracts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  statfs,
  truncate,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Context, Duration, Effect, Layer, Schedule } from "effect";

import { MachineAppsService } from "../machineApps/MachineAppsService.ts";
import { parseDockerPs } from "../machineApps/discoveryParsers.ts";
import type { ScannedApp } from "../machineApps/machineAppsScan.ts";
import { UnoCloudFetchError } from "../workspaceRegistry/UnoCloudService.ts";
import {
  groupProcesses,
  type ContainerRef,
  type ManifestAppRef,
  type MeasuredProcess,
  type ServiceRef,
} from "./resourceGroups.ts";
import {
  PF_KTHREAD,
  parseCmdline,
  parseCpuTotals,
  parseDockerSize,
  parseDockerSystemDf,
  parseDu,
  parseMacPs,
  parseMacPsArgs,
  parseMacSwap,
  parseMeminfo,
  parseNetDev,
  parseProcStat,
  parseStatusUid,
  parseVmStat,
  type MemoryReading,
  type RawProcess,
} from "./resourceParsers.ts";

const HISTORY_STEP = Duration.seconds(5);
const HISTORY_POINTS = 120;
/** A process snapshot older than this can't be diffed for CPU: sample twice. */
const CPU_BASELINE_MAX_AGE_MS = 20_000;
const CPU_BASELINE_WAIT_MS = 500;
const DOCKER_TTL_MS = 10_000;
const DISK_SCAN_TTL_MS = 10 * 60_000;
const DISK_SCAN_TIMEOUT_MS = 5 * 60_000;
/** How long a disk request waits for a scan before answering "still measuring". */
const DISK_ANSWER_WAIT_MS = 1_500;
const DISK_ENTRIES_MAX = 200;
const QUIT_WAIT_MS = 3_000;

export interface ComputerResourcesServiceShape {
  readonly snapshot: Effect.Effect<UnoComputerResources>;
  readonly diskUsage: (input: UnoDiskUsageInput) => Effect.Effect<UnoDiskUsage, UnoCloudFetchError>;
  readonly clean: (
    input: UnoDiskCleanInput,
  ) => Effect.Effect<UnoDiskCleanResult, UnoCloudFetchError>;
  readonly action: (
    input: UnoResourceActionInput,
  ) => Effect.Effect<UnoResourceActionResult, UnoCloudFetchError>;
}

export class ComputerResourcesService extends Context.Service<
  ComputerResourcesService,
  ComputerResourcesServiceShape
>()("t3/computerResources/ComputerResourcesService") {}

class ActionError extends Error {}

export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** The program isn't installed. */
  readonly missing: boolean;
}

export function execCommand(
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs = 10_000,
  /** Locale for the command; `C` keeps output parseable, a Mac's ps needs UTF-8 for names. */
  locale = "C",
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, LC_ALL: locale },
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : (error.code ?? null);
        resolve({
          code: typeof code === "number" ? code : null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          missing: error !== null && (error as NodeJS.ErrnoException).code === "ENOENT",
        });
      },
    );
  });
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Is `child` the same as or inside `parent` (both absolute, resolved)? */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/* ------------------------------------------------------------------ *
 * Clean-up targets: fixed, each one refills itself when needed.
 * ------------------------------------------------------------------ */

interface CleanTarget {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly mode: "contents" | "logs" | "docker" | "info";
  readonly paths: (home: string, platform: NodeJS.Platform) => string[];
}

export const CLEAN_TARGETS: ReadonlyArray<CleanTarget> = [
  {
    id: "npm-cache",
    label: "npm download cache",
    description: "Packages npm keeps to install faster. Downloaded again when needed.",
    mode: "contents",
    paths: (home) => [path.join(home, ".npm", "_cacache")],
  },
  {
    id: "bun-cache",
    label: "Bun download cache",
    description: "Packages Bun keeps to install faster. Downloaded again when needed.",
    mode: "contents",
    paths: (home) => [path.join(home, ".bun", "install", "cache")],
  },
  {
    id: "pip-cache",
    label: "Python (pip) cache",
    description: "Python packages kept to install faster. Downloaded again when needed.",
    mode: "contents",
    paths: (home, platform) =>
      platform === "darwin"
        ? [path.join(home, "Library", "Caches", "pip")]
        : [path.join(home, ".cache", "pip")],
  },
  {
    id: "uv-cache",
    label: "Python (uv) cache",
    description: "Python packages uv keeps to install faster. Downloaded again when needed.",
    mode: "contents",
    paths: (home) => [path.join(home, ".cache", "uv")],
  },
  {
    id: "yarn-cache",
    label: "Yarn cache",
    description: "Packages Yarn keeps to install faster. Downloaded again when needed.",
    mode: "contents",
    paths: (home, platform) =>
      platform === "darwin"
        ? [path.join(home, "Library", "Caches", "Yarn")]
        : [path.join(home, ".cache", "yarn")],
  },
  {
    id: "go-cache",
    label: "Go build cache",
    description: "Compiled Go code kept to build faster. Rebuilt when needed.",
    mode: "contents",
    paths: (home, platform) =>
      platform === "darwin"
        ? [path.join(home, "Library", "Caches", "go-build")]
        : [path.join(home, ".cache", "go-build")],
  },
  {
    id: "trash",
    label: "Trash",
    description: "Files you deleted. Emptying it removes them for good.",
    mode: "contents",
    paths: (home, platform) =>
      platform === "linux" ? [path.join(home, ".local", "share", "Trash")] : [],
  },
  {
    id: "old-logs",
    label: "Old logs",
    description: "npm's error logs and the output logs of apps registered in ~/.uno/apps.",
    mode: "logs",
    paths: (home) => [path.join(home, ".npm", "_logs"), path.join(home, ".uno", "apps")],
  },
  {
    id: "docker-unused",
    label: "Unused Docker images and build cache",
    description:
      "Leftover image layers nothing uses and Docker's build cache. Running apps and their data are not touched.",
    mode: "docker",
    paths: () => [],
  },
  {
    id: "apt-cache",
    label: "System package downloads (apt)",
    description: "Installers the system kept after updates.",
    mode: "info",
    paths: (_home, platform) => (platform === "linux" ? ["/var/cache/apt/archives"] : []),
  },
];

/* ------------------------------------------------------------------ */

export interface ComputerResourcesOptions {
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  readonly exec?: typeof execCommand;
  /** Tests turn the history sampler off. */
  readonly background?: boolean;
}

interface DiskScan {
  at: number | null;
  total: number | null;
  entries: UnoDiskEntry[];
  unreadable: number;
  error: string | null;
  running: Promise<void> | null;
}

interface HomeExtras {
  cleanables: UnoDiskCleanable[];
  docker: UnoDiskDockerUsage;
}

export const makeComputerResourcesService = (options: ComputerResourcesOptions = {}) =>
  Effect.gen(function* () {
    const machineApps = yield* MachineAppsService;
    const platform = options.platform ?? process.platform;
    const home = options.home ?? os.homedir();
    const exec = options.exec ?? execCommand;
    const selfUid = typeof process.getuid === "function" ? process.getuid() : -1;
    const selfPid = process.pid;

    /* ---------------- constants of the OS ---------------- */

    let pageSize = 4096;
    let clockTicks = 100;
    if (platform === "linux") {
      const [ps, ct] = yield* Effect.promise(() =>
        Promise.all([exec("getconf", ["PAGESIZE"], 2_000), exec("getconf", ["CLK_TCK"], 2_000)]),
      );
      pageSize = Number(ps.stdout.trim()) || 4096;
      clockTicks = Number(ct.stdout.trim()) || 100;
    }
    const cpuCount = () => Math.max(1, os.cpus().length);

    /* ---------------- whole-machine readings ---------------- */

    const readMemory = async (): Promise<MemoryReading> => {
      if (platform === "linux") {
        const parsed = parseMeminfo((await readText("/proc/meminfo")) ?? "");
        if (parsed) return parsed;
      }
      if (platform === "darwin") {
        const [vm, swap] = await Promise.all([
          exec("vm_stat", [], 3_000),
          exec("sysctl", ["-n", "vm.swapusage"], 3_000),
        ]);
        const parsed = parseVmStat(vm.stdout, os.totalmem());
        if (parsed) {
          const s = parseMacSwap(swap.stdout);
          return s ? { ...parsed, swapTotalMb: s.totalMb, swapUsedMb: s.usedMb } : parsed;
        }
      }
      const totalMb = Math.round(os.totalmem() / 1024 / 1024);
      const freeMb = Math.round(os.freemem() / 1024 / 1024);
      return {
        totalMb,
        usedMb: totalMb - freeMb,
        cacheMb: 0,
        freeMb,
        availableMb: freeMb,
        swapTotalMb: 0,
        swapUsedMb: 0,
      };
    };

    const readCpuTotals = async (): Promise<{ idle: number; total: number } | null> => {
      if (platform === "linux") return parseCpuTotals((await readText("/proc/stat")) ?? "");
      let idle = 0;
      let total = 0;
      for (const cpu of os.cpus()) {
        const t = cpu.times;
        idle += t.idle;
        total += t.user + t.nice + t.sys + t.idle + t.irq;
      }
      return { idle, total };
    };

    const readNet = async () =>
      platform === "linux" ? parseNetDev((await readText("/proc/net/dev")) ?? "") : null;

    const volumes = async (): Promise<UnoResourcesDiskVolume[]> => {
      const read = async (mount: string, label: string) => {
        try {
          const s = await statfs(mount);
          const gb = (blocks: number | bigint) => (Number(blocks) * Number(s.bsize)) / 1024 ** 3;
          const totalGb = gb(s.blocks);
          const freeGb = gb(s.bavail);
          return {
            label,
            mount,
            totalGb: round2(totalGb),
            usedGb: round2(gb(Number(s.blocks) - Number(s.bfree))),
            freeGb: round2(freeGb),
            _blocks: Number(s.blocks),
          };
        } catch {
          return null;
        }
      };
      const homeVolume = await read(home, "Home folder");
      // A Mac's "/" is the sealed system volume; its free space is the home's.
      const rootVolume = platform === "darwin" ? null : await read("/", "System disk");
      const result: UnoResourcesDiskVolume[] = [];
      if (homeVolume) {
        const { _blocks, ...v } = homeVolume;
        result.push(
          rootVolume && rootVolume._blocks === _blocks ? { ...v, label: "Disk", mount: home } : v,
        );
      }
      if (rootVolume && (!homeVolume || rootVolume._blocks !== homeVolume._blocks)) {
        const { _blocks, ...v } = rootVolume;
        result.push(v);
      }
      return result;
    };

    /* ---------------- history ring buffer ---------------- */

    const history: UnoResourcesPoint[] = [];
    let lastCpu: { idle: number; total: number } | null = null;
    let lastNet: { rx: number; tx: number; at: number } | null = null;
    let lastPoint: UnoResourcesPoint | null = null;

    const sampleHistory = async () => {
      const [cpu, memory, net] = await Promise.all([readCpuTotals(), readMemory(), readNet()]);
      let cpuPct: number | null = null;
      if (cpu && lastCpu && cpu.total > lastCpu.total) {
        const dt = cpu.total - lastCpu.total;
        cpuPct = clampPct((1 - (cpu.idle - lastCpu.idle) / dt) * 100);
      }
      lastCpu = cpu;
      const now = Date.now();
      let rx: number | null = null;
      let tx: number | null = null;
      if (net && lastNet && now > lastNet.at) {
        const seconds = (now - lastNet.at) / 1000;
        rx = Math.max(0, (net.rx - lastNet.rx) / seconds);
        tx = Math.max(0, (net.tx - lastNet.tx) / seconds);
      }
      if (net) lastNet = { ...net, at: now };
      const point: UnoResourcesPoint = {
        t: new Date(now).toISOString(),
        cpuPct: cpuPct === null ? null : round1(cpuPct),
        memUsedMb: memory.usedMb,
        netRxBps: rx === null ? null : Math.round(rx),
        netTxBps: tx === null ? null : Math.round(tx),
      };
      lastPoint = point;
      // The first reading has no "before": it only sets the baseline.
      if (cpuPct !== null) {
        history.push(point);
        if (history.length > HISTORY_POINTS) history.splice(0, history.length - HISTORY_POINTS);
      }
      return { point, memory };
    };

    /* ---------------- processes ---------------- */

    const readLinuxProcesses = async (): Promise<RawProcess[]> => {
      let names: string[] = [];
      try {
        names = await readdir("/proc");
      } catch {
        return [];
      }
      const pids = names.filter((n) => /^\d+$/.test(n)).map(Number);
      const results = await Promise.all(
        pids.map(async (pid): Promise<RawProcess | null> => {
          const [statText, statusText, cmdlineText, cgroupText] = await Promise.all([
            readText(`/proc/${pid}/stat`),
            readText(`/proc/${pid}/status`),
            readText(`/proc/${pid}/cmdline`),
            readText(`/proc/${pid}/cgroup`),
          ]);
          const s = statText ? parseProcStat(statText) : null;
          if (!s) return null;
          const uid = statusText ? parseStatusUid(statusText) : null;
          const kernelThread = (s.flags & PF_KTHREAD) !== 0 || s.ppid === 2 || s.pid === 2;
          return {
            pid: s.pid,
            ppid: s.ppid,
            uid: uid ?? 0,
            name: s.comm,
            command: cmdlineText ? parseCmdline(cmdlineText) : null,
            exe: null,
            startToken: `l${s.starttime}`,
            memMb: (s.rssPages * pageSize) / 1024 / 1024,
            cpuTicks: s.utime + s.stime,
            cpuPctPerCore: null,
            kernelThread,
            cgroup: cgroupText,
          };
        }),
      );
      return results.filter((p): p is RawProcess => p !== null);
    };

    const readMacProcesses = async (): Promise<RawProcess[]> => {
      const [ps, args] = await Promise.all([
        exec(
          "ps",
          ["-axww", "-o", "pid=,ppid=,uid=,rss=,%cpu=,lstart=,comm="],
          8_000,
          "en_US.UTF-8",
        ),
        exec("ps", ["-axww", "-o", "pid=,args="], 8_000, "en_US.UTF-8"),
      ]);
      const commands = parseMacPsArgs(args.stdout);
      return parseMacPs(ps.stdout).map((p) => ({ ...p, command: commands.get(p.pid) ?? null }));
    };

    let tickBaseline: { at: number; ticks: Map<string, number> } | null = null;

    /** Processes with their share of the processor since the last read. */
    const readProcesses = async (fresh: boolean): Promise<MeasuredProcess[]> => {
      const cores = cpuCount();
      if (platform === "darwin") {
        const raw = await readMacProcesses();
        return raw.map((p) => ({ ...p, cpuPct: clampPct((p.cpuPctPerCore ?? 0) / cores) }));
      }
      if (platform !== "linux") return [];
      const key = (p: RawProcess) => `${p.pid}:${p.startToken}`;
      if (fresh && (!tickBaseline || Date.now() - tickBaseline.at > CPU_BASELINE_MAX_AGE_MS)) {
        const first = await readLinuxProcesses();
        tickBaseline = {
          at: Date.now(),
          ticks: new Map(first.map((p) => [key(p), p.cpuTicks ?? 0])),
        };
        await sleep(CPU_BASELINE_WAIT_MS);
      }
      const now = Date.now();
      const raw = await readLinuxProcesses();
      const baseline = tickBaseline;
      const seconds = baseline ? Math.max(0.1, (now - baseline.at) / 1000) : 1;
      const measured = raw.map((p) => {
        const before = baseline?.ticks.get(key(p));
        const delta = before === undefined ? 0 : Math.max(0, (p.cpuTicks ?? 0) - before);
        return { ...p, cpuPct: clampPct((delta / clockTicks / seconds / cores) * 100) };
      });
      if (fresh)
        tickBaseline = { at: now, ticks: new Map(raw.map((p) => [key(p), p.cpuTicks ?? 0])) };
      return measured;
    };

    /* ---------------- docker ---------------- */

    let dockerCache: {
      at: number;
      access: UnoResourcesDockerAccess;
      containers: ReturnType<typeof parseDockerPs>;
    } | null = null;

    const dockerAccessFrom = (result: ExecResult): UnoResourcesDockerAccess => {
      if (result.code === 0) return "ok";
      if (result.missing) return "not-running";
      if (/permission denied/i.test(result.stderr)) return "no-access";
      if (existsSync("/var/run/docker.sock") && !/cannot connect/i.test(result.stderr)) {
        return "no-access";
      }
      return "not-running";
    };

    const readDocker = async () => {
      if (dockerCache && Date.now() - dockerCache.at < DOCKER_TTL_MS) return dockerCache;
      const ps = await exec("docker", ["ps", "--no-trunc", "--format", "{{json .}}"], 8_000);
      const access = dockerAccessFrom(ps);
      dockerCache = {
        at: Date.now(),
        access,
        containers: access === "ok" ? parseDockerPs(ps.stdout) : [],
      };
      return dockerCache;
    };

    /* ---------------- grouping ---------------- */

    const cwdOf = async (pids: number[]): Promise<Map<number, string>> => {
      const map = new Map<number, string>();
      if (pids.length === 0) return map;
      if (platform === "linux") {
        await Promise.all(
          pids.map(async (pid) => {
            try {
              map.set(pid, await readlink(`/proc/${pid}/cwd`));
            } catch {
              // Not ours, or gone.
            }
          }),
        );
        return map;
      }
      if (platform === "darwin") {
        const result = await exec(
          "lsof",
          ["-a", "-d", "cwd", "-Fpn", "-p", pids.slice(0, 50).join(",")],
          5_000,
        );
        let current: number | null = null;
        for (const line of result.stdout.split("\n")) {
          if (line.startsWith("p")) current = Number(line.slice(1));
          else if (line.startsWith("n") && current !== null) map.set(current, line.slice(1));
        }
      }
      return map;
    };

    const buildGroups = async (fresh: boolean, scanned: ReadonlyArray<ScannedApp>) => {
      const [processes, docker] = await Promise.all([readProcesses(fresh), readDocker()]);
      const manifestApps: ManifestAppRef[] = scanned
        .filter((a) => a.source === "manifest")
        .map((a) => ({
          appId: a.id,
          name: a.name,
          icon: a.icon,
          listenerPid: a.control.kind === "process" ? a.control.pid : null,
        }));
      const dockerApps = new Map(
        scanned.filter((a) => a.source === "docker").map((a) => [a.id, a] as const),
      );
      const containers =
        docker.access === "ok"
          ? new Map<string, ContainerRef>(
              docker.containers.map((c) => {
                const app = dockerApps.get(`docker:${c.name}`);
                return [
                  c.id,
                  {
                    id: c.id,
                    name: c.name,
                    image: c.image,
                    machineAppId: app?.id ?? null,
                    displayName: app?.name ?? c.labels["uno.app.name"] ?? null,
                  },
                ];
              }),
            )
          : null;
      const services: ServiceRef[] = scanned.flatMap((a) =>
        a.control.kind === "systemd"
          ? [
              {
                unit: a.control.unit,
                user: a.control.user,
                machineAppId: a.id,
                name: a.name,
                icon: a.icon,
              },
            ]
          : [],
      );
      const agentPids = processes
        .filter((p) => p.ppid === selfPid && p.uid === selfUid)
        .map((p) => p.pid);
      const cwdByPid = await cwdOf(agentPids);
      const result = groupProcesses({
        platform,
        processes,
        selfPid,
        selfUid,
        manifestApps,
        containers,
        dockerAccess: docker.access === "ok",
        services,
        cwdByPid,
      });
      return { ...result, processes, docker, containers };
    };

    const scannedApps = machineApps.scanned.pipe(
      Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<ScannedApp>)),
    );

    const snapshot: ComputerResourcesServiceShape["snapshot"] = Effect.flatMap(
      scannedApps,
      (scanned) =>
        Effect.promise(async () => {
          const [grouped, memory, vols] = await Promise.all([
            buildGroups(true, scanned),
            readMemory(),
            volumes(),
          ]);
          const notes: string[] = [];
          if (platform === "darwin") {
            notes.push(
              "On a Mac, memory per program is what it holds right now; shared memory is counted in each.",
            );
          }
          if (
            grouped.docker.access === "no-access" &&
            grouped.groups.some((g) => g.kind === "docker")
          ) {
            notes.push(
              "Uno Work may not ask Docker about containers on this computer, so they show without names and can't be stopped from here.",
            );
          }
          const load = os.loadavg()[0];
          const point = lastPoint;
          return {
            platform,
            sampledAt: new Date().toISOString(),
            cpuCount: cpuCount(),
            cpuPct: point?.cpuPct ?? round1(grouped.groups.reduce((s, g) => s + g.cpuPct, 0)),
            load1: platform === "win32" || load === undefined ? null : round2(load),
            memory,
            volumes: vols,
            netRxBps: point?.netRxBps ?? null,
            netTxBps: point?.netTxBps ?? null,
            history: [...history],
            historyStepS: Duration.toSeconds(HISTORY_STEP),
            groups: grouped.groups,
            processCount: grouped.processes.length,
            docker: grouped.docker.access,
            notes,
          } satisfies UnoComputerResources;
        }),
    );

    /* ---------------- disk ---------------- */

    const scans = new Map<string, DiskScan>();
    let homeExtras: { at: number; value: HomeExtras; running: Promise<void> | null } | null = null;
    // One `du` at a time: two walks of the same disk only slow each other.
    let duQueue: Promise<unknown> = Promise.resolve();

    const runDu = (target: string): Promise<ExecResult> => {
      const job = duQueue.then(() =>
        exec("nice", ["-n", "19", "du", "-xk", "-d", "1", target], DISK_SCAN_TIMEOUT_MS),
      );
      duQueue = job.catch(() => undefined);
      return job;
    };

    const scanFolder = async (target: string, state: DiskScan) => {
      const result = await runDu(target);
      const lines = parseDu(result.stdout);
      if (lines.length === 0) {
        state.error =
          result.code === null
            ? "Measuring took too long. Try a smaller folder."
            : "Couldn't measure this folder.";
        state.at = Date.now();
        return;
      }
      const normalized = path.resolve(target);
      let total: number | null = null;
      const entries: UnoDiskEntry[] = [];
      for (const line of lines) {
        const full = path.resolve(line.path);
        if (full === normalized) {
          total = line.bytes;
          continue;
        }
        if (path.dirname(full) !== normalized) continue;
        entries.push({ name: path.basename(full), path: full, bytes: line.bytes, isDir: true });
      }
      // `du -d 1` lists folders only (a Mac's du can't combine it with -a): add the files.
      try {
        for (const name of await readdir(normalized)) {
          const full = path.join(normalized, name);
          const info = await lstat(full).catch(() => null);
          if (!info || info.isDirectory()) continue;
          entries.push({ name, path: full, bytes: Number(info.blocks) * 512, isDir: false });
        }
      } catch {
        // Unreadable: the folders du saw are still worth showing.
      }
      entries.sort((a, b) => b.bytes - a.bytes);
      const top = entries.slice(0, DISK_ENTRIES_MAX);
      state.entries = top;
      state.total = total;
      state.unreadable = (
        result.stderr.match(/(Permission denied|Operation not permitted)/g) ?? []
      ).length;
      state.error = null;
      state.at = Date.now();
    };

    const measurePaths = async (paths: string[]): Promise<number | null> => {
      const existing = paths.filter((p) => existsSync(p));
      if (existing.length === 0) return 0;
      const result = await exec("du", ["-sk", ...existing], 120_000);
      const lines = parseDu(result.stdout);
      return lines.length === 0 ? null : lines.reduce((s, l) => s + l.bytes, 0);
    };

    const logFiles = async (): Promise<string[]> => {
      const files: string[] = [];
      const npmLogs = path.join(home, ".npm", "_logs");
      try {
        for (const name of await readdir(npmLogs)) files.push(path.join(npmLogs, name));
      } catch {
        // None.
      }
      const appsDir = path.join(home, ".uno", "apps");
      try {
        for (const name of await readdir(appsDir)) {
          if (name.endsWith(".log")) files.push(path.join(appsDir, name));
        }
      } catch {
        // None.
      }
      return files;
    };

    const sizeOfFiles = async (files: string[]) => {
      let total = 0;
      for (const file of files) {
        try {
          const s = await lstat(file);
          if (s.isFile()) total += s.size;
        } catch {
          // Gone.
        }
      }
      return total;
    };

    const dockerDangling = async (): Promise<number | null> => {
      const result = await exec(
        "docker",
        ["images", "-f", "dangling=true", "--format", "{{.Size}}"],
        20_000,
      );
      if (result.code !== 0) return null;
      return result.stdout
        .split("\n")
        .map((l) => parseDockerSize(l.trim()) ?? 0)
        .reduce((a, b) => a + b, 0);
    };

    const readHomeExtras = async (): Promise<HomeExtras> => {
      const docker = await readDocker();
      let dockerUsage: UnoDiskDockerUsage = {
        access: docker.access,
        imagesBytes: null,
        containersBytes: null,
        volumesBytes: null,
        buildCacheBytes: null,
        reclaimableBytes: null,
      };
      if (docker.access === "ok") {
        const [df, dangling] = await Promise.all([
          exec("docker", ["system", "df", "--format", "{{json .}}"], 60_000),
          dockerDangling(),
        ]);
        const parsed = parseDockerSystemDf(df.stdout);
        if (parsed) {
          dockerUsage = {
            access: "ok",
            imagesBytes: parsed.imagesBytes,
            containersBytes: parsed.containersBytes,
            volumesBytes: parsed.volumesBytes,
            buildCacheBytes: parsed.buildCacheBytes,
            reclaimableBytes: (dangling ?? 0) + (parsed.buildCacheReclaimableBytes ?? 0),
          };
        }
      }
      const cleanables: UnoDiskCleanable[] = [];
      for (const target of CLEAN_TARGETS) {
        if (target.mode === "docker") {
          if (docker.access === "not-running") continue;
          cleanables.push({
            id: target.id,
            label: target.label,
            description: target.description,
            bytes: dockerUsage.reclaimableBytes,
            canClean: docker.access === "ok" && (dockerUsage.reclaimableBytes ?? 0) > 0,
            blockedReason:
              docker.access === "no-access"
                ? "Uno Work may not use Docker on this computer — an admin can clean it."
                : (dockerUsage.reclaimableBytes ?? 0) > 0
                  ? null
                  : "Nothing to clean.",
          });
          continue;
        }
        const paths = target.paths(home, platform);
        if (paths.length === 0) continue;
        const bytes =
          target.mode === "logs" ? await sizeOfFiles(await logFiles()) : await measurePaths(paths);
        if (target.mode === "info") {
          if ((bytes ?? 0) < 50 * 1024 * 1024) continue;
          cleanables.push({
            id: target.id,
            label: target.label,
            description: target.description,
            bytes,
            canClean: false,
            blockedReason: "Only an admin can clean this (sudo apt-get clean).",
          });
          continue;
        }
        if (bytes === 0) continue;
        cleanables.push({
          id: target.id,
          label: target.label,
          description: target.description,
          bytes,
          canClean: (bytes ?? 0) > 0,
          blockedReason: null,
        });
      }
      cleanables.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
      return { cleanables, docker: dockerUsage };
    };

    const resolveTarget = async (requested: string | undefined): Promise<string> => {
      const realHome = await realpath(home).catch(() => home);
      if (!requested) return realHome;
      if (!path.isAbsolute(requested))
        throw new ActionError("Pick a folder inside your home folder.");
      const resolved = await realpath(path.resolve(requested)).catch(() => null);
      if (!resolved) throw new ActionError("That folder isn't there anymore.");
      if (!isInside(realHome, resolved)) {
        throw new ActionError("Only folders inside your home folder can be measured here.");
      }
      const s = await stat(resolved);
      if (!s.isDirectory()) throw new ActionError("That's a file, not a folder.");
      return resolved;
    };

    const diskUsage: ComputerResourcesServiceShape["diskUsage"] = (input) =>
      Effect.tryPromise({
        try: async (): Promise<UnoDiskUsage> => {
          const target = await resolveTarget(input.path);
          const realHome = await realpath(home).catch(() => home);
          const isHome = target === realHome;
          let state = scans.get(target);
          if (!state) {
            state = {
              at: null,
              total: null,
              entries: [],
              unreadable: 0,
              error: null,
              running: null,
            };
            scans.set(target, state);
          }
          const stale = state.at === null || Date.now() - state.at > DISK_SCAN_TTL_MS;
          if ((stale || input.rescan) && !state.running) {
            const s = state;
            s.running = scanFolder(target, s)
              .catch(() => {
                s.error = "Couldn't measure this folder.";
              })
              .finally(() => {
                s.running = null;
              });
          }
          if (isHome) {
            const extrasStale = !homeExtras || Date.now() - homeExtras.at > DISK_SCAN_TTL_MS;
            if ((extrasStale || input.rescan) && !homeExtras?.running) {
              const previous = homeExtras?.value ?? {
                cleanables: [],
                docker: {
                  access: "not-running" as const,
                  imagesBytes: null,
                  containersBytes: null,
                  volumesBytes: null,
                  buildCacheBytes: null,
                  reclaimableBytes: null,
                },
              };
              const holder: { at: number; value: HomeExtras; running: Promise<void> | null } = {
                at: homeExtras?.at ?? 0,
                value: previous,
                running: null,
              };
              holder.running = readHomeExtras()
                .then((value) => {
                  holder.value = value;
                  holder.at = Date.now();
                })
                .catch(() => undefined)
                .finally(() => {
                  holder.running = null;
                });
              homeExtras = holder;
            }
          }
          const waiting = [state.running, isHome ? homeExtras?.running : null].filter(
            (p): p is Promise<void> => p != null,
          );
          if (waiting.length > 0) {
            await Promise.race([Promise.all(waiting), sleep(DISK_ANSWER_WAIT_MS)]);
          }
          const vols = await volumes();
          const homeVolume = vols[0] ?? null;
          const homeTotal = isHome ? state.total : (scans.get(realHome)?.total ?? null);
          return {
            home: realHome,
            path: target,
            scanning: state.running !== null || (isHome && homeExtras?.running != null),
            scannedAt: state.at ? new Date(state.at).toISOString() : null,
            totalBytes: state.total,
            entries: state.entries,
            unreadable: state.unreadable,
            volumes: vols,
            cleanables: isHome ? (homeExtras?.value.cleanables ?? []) : [],
            docker: homeExtras?.value.docker ?? {
              access: "not-running",
              imagesBytes: null,
              containersBytes: null,
              volumesBytes: null,
              buildCacheBytes: null,
              reclaimableBytes: null,
            },
            outsideHomeBytes:
              homeVolume && homeTotal !== null
                ? Math.max(0, homeVolume.usedGb * 1024 ** 3 - homeTotal)
                : null,
            error: state.error,
          };
        },
        catch: (cause) =>
          new UnoCloudFetchError({
            message: cause instanceof ActionError ? cause.message : "Couldn't look at the disk.",
          }),
      });

    const emptyFolder = async (dir: string, realHome: string) => {
      let s;
      try {
        s = await lstat(dir);
      } catch {
        return;
      }
      if (!s.isDirectory() || s.isSymbolicLink()) return;
      const resolved = await realpath(dir);
      if (!isInside(realHome, resolved) || resolved === realHome) return;
      for (const name of await readdir(resolved)) {
        await rm(path.join(resolved, name), { recursive: true, force: true });
      }
    };

    const clean: ComputerResourcesServiceShape["clean"] = (input) =>
      Effect.tryPromise({
        try: async (): Promise<UnoDiskCleanResult> => {
          const target = CLEAN_TARGETS.find((t) => t.id === input.id);
          if (!target || target.mode === "info")
            throw new ActionError("That can't be cleaned from here.");
          const realHome = await realpath(home).catch(() => home);
          let freed = 0;
          if (target.mode === "docker") {
            const docker = await readDocker();
            if (docker.access !== "ok") {
              throw new ActionError("Uno Work may not use Docker on this computer.");
            }
            const results = await Promise.all([
              exec("docker", ["image", "prune", "-f"], 300_000),
              exec("docker", ["builder", "prune", "-f"], 300_000),
            ]);
            for (const r of results) {
              const m = /Total reclaimed space:\s*(\S+)/.exec(r.stdout);
              freed += m ? (parseDockerSize(m[1]!) ?? 0) : 0;
            }
            if (results.every((r) => r.code !== 0))
              throw new ActionError("Docker didn't clean up.");
          } else if (target.mode === "logs") {
            const files = await logFiles();
            freed = await sizeOfFiles(files);
            for (const file of files) {
              const s = await lstat(file).catch(() => null);
              if (!s?.isFile()) continue;
              const resolved = await realpath(file).catch(() => null);
              if (!resolved || !isInside(realHome, resolved)) continue;
              // App logs are open by running apps: empty them rather than delete.
              if (file.endsWith(".log") && file.includes(`${path.sep}.uno${path.sep}`)) {
                await truncate(resolved, 0).catch(() => undefined);
              } else {
                await rm(resolved, { force: true }).catch(() => undefined);
              }
            }
          } else {
            const paths = target.paths(home, platform);
            const before = (await measurePaths(paths)) ?? 0;
            for (const dir of paths) await emptyFolder(dir, realHome);
            const after = (await measurePaths(paths)) ?? 0;
            freed = Math.max(0, before - after);
          }
          // The home answer is out of date now.
          const homeScan = scans.get(realHome);
          if (homeScan) homeScan.at = null;
          if (homeExtras) homeExtras.at = 0;
          return {
            freedBytes: freed,
            message:
              freed > 0 ? `Freed ${formatBytes(freed)}.` : "Done — there was nothing to free.",
          };
        },
        catch: (cause) =>
          new UnoCloudFetchError({
            message:
              cause instanceof ActionError ? cause.message : "Cleaning didn't finish. Try again.",
          }),
      });

    /* ---------------- actions ---------------- */

    const waitGone = async (pids: number[], ms: number) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (pids.every((pid) => !isAlive(pid))) return true;
        await sleep(150);
      }
      return pids.every((pid) => !isAlive(pid));
    };

    const action: ComputerResourcesServiceShape["action"] = (input) =>
      Effect.gen(function* () {
        const scanned = yield* scannedApps;
        const current = yield* Effect.promise(() => buildGroups(false, scanned));
        // A registered app is stopped the way its desktop tile stops it.
        if (input.kind === "group") {
          const group = current.groups.find((g) => g.id === input.groupId);
          if (group?.kind === "app" && group.actions.includes(input.action)) {
            const appId = group.machineAppId;
            if (!appId) {
              return yield* new UnoCloudFetchError({
                message: "That app can't be controlled from here.",
              });
            }
            yield* machineApps.action({ appId, action: "stop" });
            if (input.action === "restart") yield* machineApps.action({ appId, action: "start" });
            return {
              done: true,
              message: `${group.name} ${input.action === "restart" ? "restarted" : "stopped"}.`,
            } satisfies UnoResourceActionResult;
          }
        }
        return yield* Effect.tryPromise({
          try: async (): Promise<UnoResourceActionResult> => {
            if (input.kind === "process") {
              const p = current.processes.find((x) => x.pid === input.pid);
              if (!p || p.startToken !== input.startToken) {
                return { done: true, message: "It has already quit." };
              }
              const reason = current.protectedReason.get(p.pid);
              if (reason) throw new ActionError(reason);
              try {
                process.kill(p.pid, input.signal === "force" ? "SIGKILL" : "SIGTERM");
              } catch {
                throw new ActionError("It belongs to another user, so only an admin can stop it.");
              }
              const gone = await waitGone([p.pid], input.signal === "force" ? 1_500 : QUIT_WAIT_MS);
              return gone
                ? { done: true, message: `${p.name} has quit.` }
                : {
                    done: false,
                    message: `${p.name} is still running. You can force it to quit.`,
                  };
            }
            const group = current.groups.find((g) => g.id === input.groupId);
            if (!group) return { done: true, message: "It isn't running anymore." };
            if (!group.actions.includes(input.action)) {
              throw new ActionError(group.actionsBlockedReason ?? "That can't be done from here.");
            }
            const verb = input.action === "restart" ? "restarted" : "stopped";
            switch (group.kind) {
              case "docker": {
                const name = group.id.slice("docker:".length);
                const known = [...(current.containers?.values() ?? [])].some(
                  (c) => c.name === name,
                );
                if (!known) throw new ActionError("That container isn't there anymore.");
                const r = await exec(
                  "docker",
                  [input.action === "restart" ? "restart" : "stop", name],
                  90_000,
                );
                if (r.code !== 0)
                  throw new ActionError("Docker didn't do it. Try again in a moment.");
                dockerCache = null;
                return { done: true, message: `${group.name} ${verb}.` };
              }
              case "service": {
                const unit = group.id.replace(/^service:user:/, "");
                if (!group.id.startsWith("service:user:")) {
                  throw new ActionError("It's a system service, so only an admin can stop it.");
                }
                const r = await exec(
                  "systemctl",
                  ["--user", input.action === "restart" ? "restart" : "stop", unit],
                  60_000,
                );
                if (r.code !== 0) throw new ActionError("The service didn't do it.");
                return { done: true, message: `${group.name} ${verb}.` };
              }
              case "terminal":
              case "program": {
                const members = current.processes.filter(
                  (p) => current.groupOfPid.get(p.pid) === group.id,
                );
                if (members.some((p) => current.protectedReason.has(p.pid))) {
                  throw new ActionError(
                    group.actionsBlockedReason ?? "That can't be done from here.",
                  );
                }
                for (const p of members) {
                  try {
                    process.kill(p.pid, "SIGTERM");
                  } catch {
                    // Already gone.
                  }
                }
                const gone = await waitGone(
                  members.map((p) => p.pid),
                  QUIT_WAIT_MS,
                );
                return gone
                  ? { done: true, message: `${group.name} has quit.` }
                  : { done: false, message: `Some of ${group.name} is still running.` };
              }
              default:
                throw new ActionError(
                  group.actionsBlockedReason ?? "That can't be done from here.",
                );
            }
          },
          catch: (cause) =>
            new UnoCloudFetchError({
              message:
                cause instanceof ActionError
                  ? cause.message
                  : cause instanceof UnoCloudFetchError
                    ? cause.message
                    : "That didn't work. Try again in a moment.",
            }),
        });
      });

    if (options.background !== false) {
      yield* Effect.forkScoped(
        Effect.promise(() => sampleHistory()).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.repeat(Schedule.spaced(HISTORY_STEP)),
        ),
      );
    }

    return { snapshot, diskUsage, clean, action } satisfies ComputerResourcesServiceShape;
  });

export const ComputerResourcesServiceLive = Layer.effect(
  ComputerResourcesService,
  makeComputerResourcesService(),
);

function clampPct(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) {
    const mb = bytes / 1024 ** 2;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
