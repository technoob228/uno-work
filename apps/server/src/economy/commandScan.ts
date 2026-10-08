/**
 * Economy mode: "is a command the agent (or the person) started still running?"
 *
 * A turn in progress keeps the computer awake (see EconomyPresence.ts). This
 * file covers what a turn leaves behind: a build, a script, a download started
 * with `nohup … &` or as a background shell of the harness, and a program left
 * running in a Work terminal. Without it the computer fell asleep ten minutes
 * after the answer, with the job frozen in the middle.
 *
 * How. The daemon runs as a systemd service, so everything it started — the
 * harnesses, their shells, whatever those forked into, even after `setsid` or
 * `nohup` — sits in the daemon's own cgroup. The scan reads that cgroup from
 * /proc and keeps what looks like work:
 *
 *   - not the daemon and not its direct children (harness servers, terminal
 *     shells, the browser — the long-lived furniture);
 *   - not a registered app (`UNO_WORK_APP` in its environment): apps wake the
 *     computer on request, or ask to stay on with `"runs": "always"`;
 *   - not a server: a program listening on a TCP port (a dev server the agent
 *     left behind) is reached through the wake gateway, like an app. The
 *     launchers above it (`npm run dev`, `sh -c`) go with it;
 *   - not plumbing: shells, tmux, editors, key agents, language servers, MCP
 *     servers, the agent's browser.
 *
 * What is left holds the computer through `running_terminals` in the report
 * (the console already treats it as "busy"), with the names in `commands`.
 * The console caps how long commands alone may hold a computer
 * (ECONOMY_HOLD_MAX_H there), so a forgotten process cannot switch economy
 * mode off for good.
 *
 * Linux + cgroup v2 only; anywhere else the scan answers "nothing".
 * The rules are pure functions (tests); reading /proc is the thin part below.
 */
import { readdir, readFile, readlink } from "node:fs/promises";

import { APP_MARKER_ENV } from "../machineApps/removeRegisteredApp.ts";

export interface ScannedProc {
  readonly pid: number;
  readonly ppid: number;
  /** Kernel name, 15 chars at most ("npm run dev", "python3"). */
  readonly comm: string;
  /** Command line, spaces for NULs, clipped. */
  readonly cmdline: string;
  /** Started by the daemon as a registered app (or forked from one). */
  readonly app: boolean;
  /** Holds a listening TCP socket. */
  readonly listening: boolean;
}

/** At most this many names travel in a report. */
export const COMMAND_NAMES_MAX = 5;
/** A cgroup with more processes than this is not read to the end: "many". */
export const SCAN_PROCS_MAX = 400;

const SHELLS = new Set(["bash", "sh", "dash", "zsh", "fish", "ksh", "tcsh", "csh"]);

/** Never work by themselves: shells, multiplexers, editors, agents of the session. */
const IGNORED_COMM = new Set([
  ...SHELLS,
  "tmux",
  "screen",
  "SCREEN",
  "byobu",
  "ssh-agent",
  "gpg-agent",
  "dirmngr",
  "keyboxd",
  "dbus-daemon",
  "dbus-launch",
  "vim",
  "vi",
  "nvim",
  "nano",
  "emacs",
  "less",
  "more",
  "man",
  "top",
  "htop",
  "btop",
  "watch",
  "tail",
  "cat",
  "ps",
  "sudo",
  "su",
]);

/** Starts something else and waits for it: goes the way of what it started. */
const LAUNCHER_COMM = new Set([
  ...SHELLS,
  "nohup",
  "env",
  "timeout",
  "setsid",
  "stdbuf",
  "nice",
  "sudo",
  "make",
  "npx",
  "pnpm",
  "yarn",
  "bunx",
  "uv",
  "uvx",
  "poetry",
  "pipenv",
  "nodemon",
  "concurrently",
  "turbo",
  "tini",
  "dumb-init",
]);

/** Helpers a harness keeps for itself: language servers, MCP servers, its browser. */
const PLUMBING_CMDLINE =
  /language-?server|langserver|\bgopls\b|rust-analyzer|pyright|pylsp|\btsserver\b|\bclangd\b|\bmcp\b|mcp[-_]server|server[-_]mcp|modelcontextprotocol|--type=(renderer|gpu-process|utility|zygote|broker)|chrome_crashpad|headless_shell|\/chrom(e|ium)(\s|$)|esbuild.*--service|\bwatchman\b/i;

function isIgnored(proc: ScannedProc): boolean {
  if (IGNORED_COMM.has(proc.comm)) return true;
  if (proc.comm.startsWith("tmux")) return true;
  return PLUMBING_CMDLINE.test(proc.cmdline);
}

function isLauncher(proc: ScannedProc): boolean {
  if (LAUNCHER_COMM.has(proc.comm)) return true;
  // npm sets its title: "npm run dev", "npm exec vite", "npm start".
  if (/^(npm|pnpm|yarn|bun)( |$)/.test(proc.comm)) return true;
  return /(^|\/)(npm|npx|pnpm|yarn)(-cli)?(\.c?js)?( |$)/.test(proc.cmdline.slice(0, 200));
}

/**
 * Names of the processes that count as work (sorted, unique, at most
 * COMMAND_NAMES_MAX). Empty — nothing holds the computer.
 */
export function pickWorkCommands(selfPid: number, procs: ReadonlyArray<ScannedProc>): string[] {
  const byPid = new Map<number, ScannedProc>();
  const children = new Map<number, number[]>();
  for (const proc of procs) {
    byPid.set(proc.pid, proc);
    const list = children.get(proc.ppid);
    if (list) list.push(proc.pid);
    else children.set(proc.ppid, [proc.pid]);
  }

  // A server and everything under it; then the launchers above it, as long as
  // launching it is all they do.
  const server = new Set<number>();
  const markDown = (pid: number) => {
    if (server.has(pid)) return;
    server.add(pid);
    for (const child of children.get(pid) ?? []) markDown(child);
  };
  for (const proc of procs) {
    if (proc.listening && proc.pid !== selfPid && proc.ppid !== selfPid) markDown(proc.pid);
  }
  for (const proc of procs) {
    if (!proc.listening) continue;
    let up = byPid.get(proc.ppid);
    for (let hops = 0; up && hops < 16; hops += 1) {
      if (up.pid === selfPid || up.ppid === selfPid || !isLauncher(up)) break;
      const kids = children.get(up.pid) ?? [];
      if (!kids.every((kid) => server.has(kid))) break;
      server.add(up.pid);
      up = byPid.get(up.ppid);
    }
  }

  const names = new Set<string>();
  for (const proc of procs) {
    if (proc.pid === selfPid || proc.ppid === selfPid) continue; // the daemon and its furniture
    if (proc.app || server.has(proc.pid) || isIgnored(proc)) continue;
    names.add(proc.comm);
  }
  return [...names].toSorted().slice(0, COMMAND_NAMES_MAX);
}

// ---- reading /proc ----

/**
 * `/proc/<pid>/stat` → comm and ppid. The name may hold spaces and brackets.
 * A zombie (exited, not yet reaped by its parent) is not a running command.
 */
export function parseProcStat(text: string): { comm: string; ppid: number } | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(rest[1]);
  if (!Number.isInteger(ppid) || rest[0] === "Z" || rest[0] === "X") return null;
  return { comm: text.slice(open + 1, close), ppid };
}

/** The daemon's own cgroup directory, only when it is a systemd service of its own. */
export function ownServiceCgroup(procSelfCgroup: string): string | null {
  for (const line of procSelfCgroup.split("\n")) {
    if (!line.startsWith("0::")) continue;
    const rel = line.slice(3).trim();
    // A service unit: everything in it was started by this daemon. A login
    // session or the root cgroup holds other people's programs — not read.
    if (!/\/[^/]+\.service$/.test(rel) || rel.includes("/user@")) return null;
    return `/sys/fs/cgroup${rel}`;
  }
  return null;
}

/** Inodes of listening TCP sockets from `/proc/net/tcp` and `tcp6`. */
export function listeningInodes(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    // sl local rem st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode …
    if (cols.length > 9 && cols[3] === "0A" && cols[9] !== "0") out.add(cols[9]!);
  }
  return out;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function holdsListeningSocket(pid: number, inodes: ReadonlySet<string>): Promise<boolean> {
  if (inodes.size === 0) return false;
  let fds: string[];
  try {
    fds = await readdir(`/proc/${pid}/fd`);
  } catch {
    return false;
  }
  for (const fd of fds.slice(0, 512)) {
    try {
      const link = await readlink(`/proc/${pid}/fd/${fd}`);
      const match = /^socket:\[(\d+)\]$/.exec(link);
      if (match && inodes.has(match[1]!)) return true;
    } catch {
      // The descriptor closed meanwhile.
    }
  }
  return false;
}

export interface CommandScan {
  /** Names of the commands that hold the computer. */
  readonly names: ReadonlyArray<string>;
}

const NOTHING: CommandScan = { names: [] };

/** `UNO_WORK_ECONOMY_COMMANDS=off` switches the scan off (a kill switch for support). */
export function commandScanEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env["UNO_WORK_ECONOMY_COMMANDS"] ?? "").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(raw);
}

/** What is running in the daemon's cgroup right now. Never throws. */
export async function scanWorkCommands(selfPid: number = process.pid): Promise<CommandScan> {
  if (process.platform !== "linux" || !commandScanEnabled()) return NOTHING;
  const cgroupText = await readText("/proc/self/cgroup");
  const dir = cgroupText === null ? null : ownServiceCgroup(cgroupText);
  if (dir === null) return NOTHING;
  const pidsText = await readText(`${dir}/cgroup.procs`);
  if (pidsText === null) return NOTHING;
  const pids = pidsText
    .split("\n")
    .map((line) => Number(line))
    .filter((pid) => Number.isInteger(pid) && pid > 1);
  if (pids.length > SCAN_PROCS_MAX) return { names: ["many"] };

  const inodes = new Set<string>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await readText(file);
    if (text !== null) for (const inode of listeningInodes(text)) inodes.add(inode);
  }

  const procs: ScannedProc[] = [];
  for (const pid of pids) {
    const stat = await readText(`/proc/${pid}/stat`);
    const parsed = stat === null ? null : parseProcStat(stat);
    if (parsed === null) continue; // gone meanwhile
    const cmdline = ((await readText(`/proc/${pid}/cmdline`)) ?? "")
      .replaceAll("\u0000", " ")
      .trim()
      .slice(0, 400);
    const furniture = pid === selfPid || parsed.ppid === selfPid;
    const environ = furniture ? null : await readText(`/proc/${pid}/environ`);
    const app =
      environ !== null &&
      environ.split("\u0000").some((entry) => entry.startsWith(`${APP_MARKER_ENV}=`));
    const listening = furniture || app ? false : await holdsListeningSocket(pid, inodes);
    procs.push({ pid, ppid: parsed.ppid, comm: parsed.comm, cmdline, app, listening });
  }
  return { names: pickWorkCommands(selfPid, procs) };
}
