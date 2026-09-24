/**
 * Removing an app registered in `~/.uno/apps` — one an AI (or the person)
 * built on this computer, not an App Store install.
 *
 * Everything here runs as the daemon's own user (`unowork` on an Uno
 * computer), never root: it can stop only that user's processes and user
 * systemd units, and delete only that user's files. What it does:
 *
 *   1. finds what runs the app — the process listening on its port, processes
 *      the daemon started for it (they carry `UNO_WORK_APP=<id>`), processes
 *      working in its code folder, and user systemd units named after it or
 *      pointing at its folder — and stops them (TERM, then KILL);
 *   2. disables and deletes those user units (a unit left behind would start
 *      the app again at the next boot);
 *   3. deletes the manifest, its icon (unless another manifest uses it), its
 *      log, and its App SDK key folder — the token dies with the manifest
 *      (AppSdkService withdraws it on its next sync, which the manifest
 *      folder's watcher triggers at once);
 *   4. only when asked, deletes the code folder — and only a folder that is
 *      the app's alone (see {@link codeFolderFor}).
 *
 * The app's cloud files are a separate, explicit step (AppSdkService,
 * `deleteCloudFiles`), asked by the confirmation's checkbox.
 */
import { readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import path from "node:path";

import type { AppManifest } from "./appManifest.ts";
import type { CommandResult } from "./machineAppsScan.ts";

/** Set on every process the daemon starts for a registered app. */
export const APP_MARKER_ENV = "UNO_WORK_APP";

/**
 * Top-level folders of home that hold more than one app's code, or the
 * person's own things: never deleted as "the app's code".
 */
const SHARED_TOP_FOLDERS = new Set(
  [
    "desktop",
    "documents",
    "downloads",
    "pictures",
    "music",
    "videos",
    "movies",
    "public",
    "templates",
    "projects",
    "code",
    "src",
    "dev",
    "repos",
    "git",
    "apps",
    "work",
    "workspace",
    "workspaces",
    "inbox",
    "meetings",
    "files",
    "bin",
    "go",
    "snap",
    "node_modules",
  ].map((name) => name.toLowerCase()),
);

export interface CodeFolder {
  /** Absolute path. */
  readonly path: string;
  /** Why it must stay; null = it may be deleted when the person asks. */
  readonly keepReason: string | null;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The app's code folder and whether "also delete the code" may touch it.
 * Pure: paths are compared as given (the caller resolves symlinks first).
 */
export function codeFolderFor(
  manifest: Pick<AppManifest, "id" | "cwd">,
  context: {
    readonly home: string;
    /** Folders that must survive: the apps folder, app keys, the daemon's state… */
    readonly protectedDirs: ReadonlyArray<string>;
    /** The other registered apps (their `cwd`). */
    readonly others: ReadonlyArray<Pick<AppManifest, "id" | "name" | "cwd">>;
  },
): CodeFolder | null {
  if (!manifest.cwd) return null;
  const dir = path.resolve(manifest.cwd);
  const home = path.resolve(context.home);
  const keep = (keepReason: string): CodeFolder => ({ path: dir, keepReason });
  if (dir === home) return keep("It runs from your home folder, which holds more than this app.");
  if (!isInside(dir, home)) return keep("It is outside your home folder.");
  const segments = path.relative(home, dir).split(path.sep);
  const top = segments[0] ?? "";
  if (segments.length === 1 && (top.startsWith(".") || SHARED_TOP_FOLDERS.has(top.toLowerCase()))) {
    return keep("It runs from a folder that holds more than this app.");
  }
  if (top === ".uno" || top === ".config" || top === ".local" || top === ".ssh") {
    return keep("It runs from a folder the computer itself uses.");
  }
  for (const protectedDir of context.protectedDirs) {
    const p = path.resolve(protectedDir);
    if (isInside(p, dir) || isInside(dir, p)) {
      return keep("It runs from a folder the computer itself uses.");
    }
  }
  for (const other of context.others) {
    if (other.id === manifest.id || !other.cwd) continue;
    const theirs = path.resolve(other.cwd);
    if (isInside(theirs, dir) || isInside(dir, theirs)) {
      return keep(`${other.name} uses the same folder.`);
    }
  }
  return { path: dir, keepReason: null };
}

/* ------------------------------------------------------------------ *
 * Processes
 * ------------------------------------------------------------------ */

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number | null;
  readonly comm: string;
  /** Resolved working directory; null when it can't be read. */
  readonly cwd: string | null;
  /** `UNO_WORK_APP` from its environment; null when absent or unreadable. */
  readonly appMarker: string | null;
}

/** Programs that are the machine, a terminal or an AI at work — never an app to stop. */
const NEVER_STOP = new Set([
  "systemd",
  "sshd",
  "sudo",
  "su",
  "login",
  "tmux",
  "tmux: server",
  "screen",
  "uno-work",
  "uno-box-agent",
  "uno-guest-agent",
  "opencode",
  "codex",
  "claude",
  "hermes",
  "cursor-agent",
]);

/**
 * Which processes run the app. `listenerPids` (on its port) and processes the
 * daemon started for it (marked) always count. A process merely working in the
 * app's folder counts only when it is not the daemon's own descendant — a
 * terminal or an AI chat sitting in that folder must survive — and is not
 * part of the machine.
 */
export function pickAppProcesses(
  table: ReadonlyArray<ProcessInfo>,
  input: {
    readonly appId: string;
    readonly selfPid: number;
    readonly uid: number | null;
    readonly listenerPids: ReadonlyArray<number>;
    readonly codeDir: string | null;
  },
): number[] {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const descendsFromSelf = (pid: number) => {
    let current = byPid.get(pid);
    for (let hops = 0; current && hops < 64; hops++) {
      if (current.ppid === input.selfPid) return true;
      if (current.ppid <= 1) return false;
      current = byPid.get(current.ppid);
    }
    return false;
  };
  const ancestorsOfSelf = new Set<number>();
  for (let p = byPid.get(input.selfPid), hops = 0; p && hops < 64; hops++) {
    ancestorsOfSelf.add(p.pid);
    p = byPid.get(p.ppid);
  }
  const picked = new Set<number>();
  for (const proc of table) {
    if (proc.pid <= 1 || proc.pid === input.selfPid || ancestorsOfSelf.has(proc.pid)) continue;
    if (input.uid !== null && proc.uid !== null && proc.uid !== input.uid) continue;
    if (NEVER_STOP.has(proc.comm)) continue;
    if (input.listenerPids.includes(proc.pid) || proc.appMarker === input.appId) {
      picked.add(proc.pid);
      continue;
    }
    if (
      input.codeDir !== null &&
      proc.cwd !== null &&
      isInside(proc.cwd, input.codeDir) &&
      !descendsFromSelf(proc.pid)
    ) {
      picked.add(proc.pid);
    }
  }
  // A listener this user can't see in /proc (another user's) is not ours to stop.
  return [...picked].toSorted((a, b) => a - b);
}

/** `/proc` of this Linux machine, as far as this user can read it. */
export async function readProcessTable(): Promise<ProcessInfo[]> {
  let names: string[];
  try {
    names = await readdir("/proc");
  } catch {
    return [];
  }
  const out: ProcessInfo[] = [];
  await Promise.all(
    names
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        const pid = Number(name);
        try {
          const status = await readFile(`/proc/${pid}/status`, "utf8");
          const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? "0");
          const uidMatch = /^Uid:\s+(\d+)/m.exec(status);
          const comm = /^Name:\s+(.*)$/m.exec(status)?.[1]?.trim() ?? "";
          const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
          const environ = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
          const marker = environ
            .split("\0")
            .find((entry) => entry.startsWith(`${APP_MARKER_ENV}=`));
          out.push({
            pid,
            ppid,
            uid: uidMatch ? Number(uidMatch[1]) : null,
            comm,
            cwd,
            appMarker: marker ? marker.slice(APP_MARKER_ENV.length + 1) : null,
          });
        } catch {
          // Gone meanwhile, or not ours to read.
        }
      }),
  );
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Gone — or EPERM: it belongs to someone else, not ours to wait for.
    return false;
  }
}

/** TERM, a few seconds to finish, then KILL. Returns the pids still alive. */
export async function stopProcesses(
  pids: ReadonlyArray<number>,
  options: {
    readonly graceMs?: number;
    readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
    readonly isAlive?: (pid: number) => boolean;
  } = {},
): Promise<number[]> {
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const isAlive = options.isAlive ?? alive;
  const graceMs = options.graceMs ?? 3_000;
  for (const pid of pids) {
    try {
      kill(pid, "SIGTERM");
    } catch {
      // Already gone or not ours.
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && pids.some(isAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  for (const pid of pids.filter(isAlive)) {
    try {
      kill(pid, "SIGKILL");
    } catch {
      // Gone.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, pids.some(isAlive) ? 300 : 0));
  return pids.filter(isAlive);
}

/* ------------------------------------------------------------------ *
 * User systemd units
 * ------------------------------------------------------------------ */

export interface UserUnitFile {
  readonly name: string;
  readonly path: string;
  readonly text: string;
}

/** `~/.config/systemd/user` — the units this user wrote (never the OS's). */
export function userUnitDir(home: string): string {
  return path.join(home, ".config", "systemd", "user");
}

export async function readUserUnitFiles(home: string): Promise<UserUnitFile[]> {
  const dir = userUnitDir(home);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: UserUnitFile[] = [];
  for (const name of names.toSorted()) {
    if (!/\.(service|timer|path|socket)$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      out.push({ name, path: file, text: (await readFile(file, "utf8")).slice(0, 64 * 1024) });
    } catch {
      // Unreadable: not something to act on.
    }
  }
  return out;
}

/**
 * The user units that run the app: named after it (`notes.service`,
 * `notes-digest.timer`, `uno-app-notes.service`), the one whose cgroup owns
 * its port, or ones that run from its code folder or read its manifest. A
 * timer comes with its service and the other way round.
 */
export function pickAppUnits(
  units: ReadonlyArray<UserUnitFile>,
  input: {
    readonly appId: string;
    readonly codeDir: string | null;
    readonly ownerUnits: ReadonlyArray<string>;
    readonly manifestPath: string;
  },
): UserUnitFile[] {
  const stem = (name: string) => name.replace(/\.(service|timer|path|socket)$/, "");
  const id = input.appId.toLowerCase();
  const named = (name: string) => {
    const s = stem(name).toLowerCase();
    return s === id || s.startsWith(`${id}-`) || s.startsWith(`${id}_`) || s === `uno-app-${id}`;
  };
  const mentions = (text: string) => {
    if (text.includes(input.manifestPath)) return true;
    if (!input.codeDir) return false;
    const dir = input.codeDir.replace(/\/+$/, "");
    return text.split("\n").some((line) => {
      if (!/^\s*(WorkingDirectory|ExecStart|ExecStartPre)\s*=/.test(line)) return false;
      const at = line.indexOf(dir);
      if (at === -1) return false;
      const after = line[at + dir.length];
      return after === undefined || after === "/" || /[\s"';]/.test(after);
    });
  };
  const picked = new Set(
    units
      .filter((u) => named(u.name) || input.ownerUnits.includes(u.name) || mentions(u.text))
      .map((u) => u.name),
  );
  for (const u of units) {
    if (picked.has(u.name)) continue;
    const partner = [...picked].some((p) => stem(p) === stem(u.name));
    // `Unit=` of a timer pointing at a picked service.
    const unitRef = /^\s*Unit\s*=\s*(\S+)/m.exec(u.text)?.[1];
    if (partner || (unitRef !== undefined && picked.has(unitRef))) picked.add(u.name);
  }
  return units.filter((u) => picked.has(u.name));
}

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

/** Resolves symlinks of an existing path; the path itself when it doesn't exist. */
export async function resolvedPath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

export interface RemoveFilesResult {
  readonly errors: ReadonlyArray<string>;
}

/** Deletes files, collecting what failed instead of stopping at the first. */
export async function removePaths(
  paths: ReadonlyArray<{ readonly path: string; readonly recursive?: boolean }>,
): Promise<RemoveFilesResult> {
  const errors: string[] = [];
  for (const item of paths) {
    try {
      await rm(item.path, { force: true, recursive: item.recursive === true });
    } catch (error) {
      errors.push(`${item.path}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
    }
  }
  return { errors };
}

export type RunCommand = (
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs?: number,
) => Promise<CommandResult>;
