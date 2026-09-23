/**
 * Pure readers of what the OS says about its load: `/proc` files on Linux,
 * `ps` / `vm_stat` / `sysctl` output on a Mac, `du` and `docker system df`.
 * No I/O here — the service feeds recorded text in, tests do the same.
 */
import { redactSecretsInText } from "../secretRedaction.ts";

export interface RawProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  /** Short program name ("node", "claude", "Google Chrome Helper"). */
  readonly name: string;
  /** Full command line when readable; null otherwise. */
  readonly command: string | null;
  /** Mac: path of the executable (to find the `.app` it belongs to). */
  readonly exe: string | null;
  readonly startToken: string;
  readonly memMb: number;
  /** Linux: cumulative user+system clock ticks; Mac: null (ps gives a %). */
  readonly cpuTicks: number | null;
  /** Mac: ps %cpu (per core); Linux: null (computed from ticks). */
  readonly cpuPctPerCore: number | null;
  /** Linux: kernel thread (no memory map). */
  readonly kernelThread: boolean;
  /** Linux: the `/proc/<pid>/cgroup` text, for container/service ownership. */
  readonly cgroup: string | null;
}

export interface ProcStat {
  readonly pid: number;
  readonly comm: string;
  readonly state: string;
  readonly ppid: number;
  readonly utime: number;
  readonly stime: number;
  readonly starttime: number;
  readonly rssPages: number;
  readonly flags: number;
}

/** `/proc/<pid>/stat`. The name is in parentheses and may itself hold spaces or parentheses. */
export function parseProcStat(content: string): ProcStat | null {
  const open = content.indexOf("(");
  const close = content.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(content.slice(0, open).trim());
  const comm = content.slice(open + 1, close);
  // Fields after the name, numbered from 3 (state) in proc(5).
  const rest = content
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const field = (n: number) => Number(rest[n - 3]);
  const stat: ProcStat = {
    pid,
    comm,
    state: rest[0] ?? "?",
    ppid: field(4),
    flags: field(9),
    utime: field(14),
    stime: field(15),
    starttime: field(22),
    rssPages: field(24),
  };
  return Number.isFinite(stat.pid) && Number.isFinite(stat.ppid) ? stat : null;
}

/** Real uid from `/proc/<pid>/status`. */
export function parseStatusUid(content: string): number | null {
  const m = /^Uid:\s+(\d+)/m.exec(content);
  return m ? Number(m[1]) : null;
}

/** `/proc/<pid>/cmdline`: NUL-separated. */
export function parseCmdline(content: string): string | null {
  const text = content.replace(/\0+$/, "").split("\0").join(" ").trim();
  return text.length > 0 ? text : null;
}

export const PF_KTHREAD = 0x00200000;

export interface MemoryReading {
  readonly totalMb: number;
  readonly usedMb: number;
  readonly cacheMb: number;
  readonly freeMb: number;
  readonly availableMb: number;
  readonly swapTotalMb: number;
  readonly swapUsedMb: number;
}

/** `/proc/meminfo` → used / cache / free, the way `free` counts them. */
export function parseMeminfo(content: string): MemoryReading | null {
  const kb = (key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(content);
    return m ? Number(m[1]) : null;
  };
  const total = kb("MemTotal");
  if (total === null) return null;
  const free = kb("MemFree") ?? 0;
  const buffers = kb("Buffers") ?? 0;
  const cached = kb("Cached") ?? 0;
  const reclaimable = kb("SReclaimable") ?? 0;
  const shmem = kb("Shmem") ?? 0;
  const available = kb("MemAvailable") ?? free + buffers + cached;
  const cache = Math.max(0, buffers + cached + reclaimable - shmem);
  const used = Math.max(0, total - free - cache);
  const swapTotal = kb("SwapTotal") ?? 0;
  const swapFree = kb("SwapFree") ?? 0;
  const mb = (v: number) => Math.round(v / 1024);
  return {
    totalMb: mb(total),
    usedMb: mb(used),
    cacheMb: mb(cache),
    freeMb: mb(free),
    availableMb: mb(available),
    swapTotalMb: mb(swapTotal),
    swapUsedMb: mb(Math.max(0, swapTotal - swapFree)),
  };
}

/** First line of `/proc/stat`: all-CPU jiffies. */
export function parseCpuTotals(content: string): { idle: number; total: number } | null {
  const line = content.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const values = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  if (values.length < 4) return null;
  // user nice system idle iowait irq softirq steal (guest time is already in user).
  const idle = (values[3] ?? 0) + (values[4] ?? 0);
  const total = values.slice(0, 8).reduce((a, b) => a + b, 0);
  return { idle, total };
}

/** Interfaces that are not the way out of the machine. */
const INTERNAL_IFACE = /^(lo|docker\d*|veth|br-|virbr|cni|flannel|tap|tun|wg|kube|podman)/;

/** `/proc/net/dev` → bytes in/out over the real interfaces. */
export function parseNetDev(content: string): { rx: number; tx: number } | null {
  let rx = 0;
  let tx = 0;
  let seen = false;
  for (const line of content.split("\n")) {
    const m = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const iface = m[1]!;
    if (INTERNAL_IFACE.test(iface)) continue;
    const cols = m[2]!.trim().split(/\s+/).map(Number);
    if (cols.length < 9) continue;
    rx += cols[0] ?? 0;
    tx += cols[8] ?? 0;
    seen = true;
  }
  return seen ? { rx, tx } : null;
}

/**
 * `ps -axww -o pid=,ppid=,uid=,rss=,%cpu=,lstart=,comm=` on a Mac. `lstart`
 * is always five words ("Tue Sep 23 10:01:02 2026"); `comm` is the rest.
 */
export function parseMacPs(output: string): RawProcess[] {
  const processes: RawProcess[] = [];
  for (const line of output.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) continue;
    const [pid, ppid, uid, rss, cpu] = parts.slice(0, 5).map(Number);
    if (![pid, ppid, uid, rss, cpu].every((n) => Number.isFinite(n))) continue;
    const lstart = parts.slice(5, 10).join(" ");
    const exe = parts.slice(10).join(" ");
    const base = exe.split("/").pop() ?? exe;
    processes.push({
      pid: pid!,
      ppid: ppid!,
      uid: uid!,
      name: base.slice(0, 80),
      command: null,
      exe,
      startToken: `m${Date.parse(lstart) / 1000 || lstart.replace(/\s+/g, "")}`,
      memMb: rss! / 1024,
      cpuTicks: null,
      cpuPctPerCore: cpu!,
      kernelThread: false,
      cgroup: null,
    });
  }
  return processes;
}

/** `ps -axww -o pid=,args=` → full command lines by pid. */
export function parseMacPsArgs(output: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2]!.trim().length > 0) map.set(Number(m[1]), m[2]!.trim());
  }
  return map;
}

/**
 * `vm_stat` + total bytes → memory the way Activity Monitor counts it:
 * used = app memory + wired + compressed; cache = file-backed + purgeable.
 */
export function parseVmStat(output: string, totalBytes: number): MemoryReading | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1] ?? 4096);
  const pages = (label: string): number => {
    const m = new RegExp(`^${label}:\\s+(\\d+)`, "m").exec(output);
    return m ? Number(m[1]) : 0;
  };
  if (!/Pages free/.test(output)) return null;
  const mb = (p: number) => Math.round((p * pageSize) / 1024 / 1024);
  const totalMb = Math.round(totalBytes / 1024 / 1024);
  const free = pages("Pages free") + pages("Pages speculative");
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor");
  const purgeable = pages("Pages purgeable");
  const fileBacked = pages("File-backed pages");
  const anonymous = pages("Anonymous pages");
  const appMemory = anonymous > 0 ? Math.max(0, anonymous - purgeable) : pages("Pages active");
  const usedMb = Math.min(totalMb, mb(appMemory + wired + compressed));
  const cacheMb = Math.min(Math.max(0, totalMb - usedMb), mb(fileBacked + purgeable));
  const freeMb = Math.max(0, Math.min(mb(free), totalMb - usedMb - cacheMb));
  return {
    totalMb,
    usedMb,
    cacheMb,
    freeMb,
    availableMb: Math.max(0, totalMb - usedMb),
    swapTotalMb: 0,
    swapUsedMb: 0,
  };
}

/** `sysctl -n vm.swapusage`: "total = 2048.00M  used = 1024.50M  free = …". */
export function parseMacSwap(output: string): { totalMb: number; usedMb: number } | null {
  const value = (key: string) => {
    const m = new RegExp(`${key} = ([\\d.]+)([MG])`).exec(output);
    if (!m) return null;
    return Number(m[1]) * (m[2] === "G" ? 1024 : 1);
  };
  const total = value("total");
  const used = value("used");
  return total === null || used === null
    ? null
    : { totalMb: Math.round(total), usedMb: Math.round(used) };
}

export interface DuLine {
  readonly path: string;
  readonly bytes: number;
}

/** `du -k …` lines: "<kilobytes>\t<path>". */
export function parseDu(output: string): DuLine[] {
  const lines: DuLine[] = [];
  for (const line of output.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const kb = Number(line.slice(0, tab).trim());
    const path = line.slice(tab + 1);
    if (!Number.isFinite(kb) || path.length === 0) continue;
    lines.push({ path, bytes: kb * 1024 });
  }
  return lines;
}

/** Docker's human sizes: "1.2GB", "800MB", "12.5kB", "0B". */
export function parseDockerSize(text: string): number | null {
  const m = /^\s*([\d.]+)\s*([kKMGT]?i?B)\b/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toUpperCase().replace("I", "");
  const scale: Record<string, number> = {
    B: 1,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
  };
  const factor = scale[unit];
  return Number.isFinite(n) && factor !== undefined ? Math.round(n * factor) : null;
}

export interface DockerDf {
  readonly imagesBytes: number | null;
  readonly containersBytes: number | null;
  readonly volumesBytes: number | null;
  readonly buildCacheBytes: number | null;
  readonly buildCacheReclaimableBytes: number | null;
}

/** `docker system df --format '{{json .}}'`. */
export function parseDockerSystemDf(output: string): DockerDf | null {
  const rows = new Map<string, { size: number | null; reclaimable: number | null }>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      const type = String(record["Type"] ?? "").toLowerCase();
      rows.set(type, {
        size: parseDockerSize(String(record["Size"] ?? "")),
        reclaimable: parseDockerSize(String(record["Reclaimable"] ?? "")),
      });
    } catch {
      // Skip a garbled line.
    }
  }
  if (rows.size === 0) return null;
  const pick = (prefix: string) =>
    [...rows.entries()].find(([type]) => type.startsWith(prefix))?.[1] ?? null;
  return {
    imagesBytes: pick("images")?.size ?? null,
    containersBytes: pick("containers")?.size ?? null,
    volumesBytes: pick("local volumes")?.size ?? null,
    buildCacheBytes: pick("build cache")?.size ?? null,
    buildCacheReclaimableBytes: pick("build cache")?.reclaimable ?? null,
  };
}

const SECRET_WORD = String.raw`[\w.-]*(?:token|secret|password|passwd|api[-_]?key|apikey|credential|private[-_]?key)[\w.-]*`;
/** `--api-key sk…`, `--password=…` */
const SECRET_FLAG = new RegExp(
  String.raw`((?:^|\s)-{1,2}${SECRET_WORD}(?:=|\s+))("[^"]*"|'[^']*'|\S+)`,
  "gi",
);
/** `API_TOKEN=…` */
const SECRET_ENV = new RegExp(String.raw`((?:^|\s)${SECRET_WORD}=)("[^"]*"|'[^']*'|\S+)`, "gi");

/** A command line safe to show: secrets masked, long lines shortened. */
export function maskCommand(command: string, maxLength = 240): string {
  const masked = redactSecretsInText(command)
    .replace(SECRET_FLAG, (_match, lead: string) => `${lead}•••`)
    .replace(SECRET_ENV, (_match, lead: string) => `${lead}•••`);
  return masked.length > maxLength ? `${masked.slice(0, maxLength - 1)}…` : masked;
}

/** The outermost `Something.app` in a Mac executable path → "Something". */
export function macAppName(exe: string | null): string | null {
  if (!exe) return null;
  const m = /\/([^/]+)\.app\//.exec(exe);
  return m ? m[1]! : null;
}
