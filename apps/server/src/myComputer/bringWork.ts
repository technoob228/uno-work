/**
 * "Bring your work?" (computers lifecycle, CONTRACT.md §2): the project folders
 * found on the person's computer with the NAMES of their keys, and bringing the
 * chosen ones over.
 *
 * Scan: ONE command on the computer lists the git folders directly in
 * `~/projects`, plus the folders found chats ran in (the chat import's index),
 * and for each the key names of its `.env` — the names are cut out there by
 * `sed`, so a value never leaves the computer during a scan. Nothing outside
 * those folders is read: no `~/.ssh`, `~/.aws`, keychains, shell profiles.
 *
 * Bring, per project: copy the folder to `~/projects/<name>` here (without
 * `.env` and rebuilt folders, `projectCopy.ts`), make it a project, turn on
 * "On all my computers" for it, then read only the chosen keys' values on the
 * computer and keep them as the project's keys (the vault; each computer
 * writes them into `.env`, 0600). An unchosen key is never read. A project
 * brought before only gets its keys again. Values are never logged.
 *
 * @module myComputer/bringWork
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

import type { ComputerWorkStatus, FoundProject } from "@t3tools/contracts";

import { safeSegment, writeJsonPrivately } from "./import/chatHistory.ts";
import type { MyComputerCore } from "./myComputerCore.ts";
import { MyComputerFailure } from "./myComputerCore.ts";
import { copyFolderFromComputer } from "./projectCopy.ts";
import { psQuote, shQuote } from "./workspaceTools.ts";

const MAX_PROJECTS = 200;
const MAX_KEYS = 100;
const SCAN_FRESH_MS = 60_000;
const SCAN_TIMEOUT_MS = 60_000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ── The scan command ───────────────────────────────────────────────────

/**
 * Prints `UNO_HOME <home>`, then per folder `UNO_P <git 0|1>\t<path>` and per
 * key `UNO_K <path>\t<NAME>`. Only names: `sed` keeps the part before `=`.
 */
export function scanCommand(extraDirs: ReadonlyArray<string>, windows: boolean): string {
  if (windows) {
    const extras = extraDirs.map(psQuote).join(", ");
    return [
      `Write-Output ("UNO_HOME " + $HOME)`,
      `$dirs = @(Get-ChildItem -LiteralPath (Join-Path $HOME 'projects') -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName '.git') } | ForEach-Object { $_.FullName })`,
      ...(extras
        ? [`$dirs += @(${extras} | Where-Object { Test-Path -LiteralPath $_ -PathType Container })`]
        : []),
      `foreach ($d in ($dirs | Select-Object -Unique -First ${MAX_PROJECTS})) {`,
      `  $g = if (Test-Path (Join-Path $d '.git')) { 1 } else { 0 }`,
      `  Write-Output ("UNO_P $g" + [char]9 + $d)`,
      `  $env = Join-Path $d '.env'`,
      `  if (Test-Path -LiteralPath $env -PathType Leaf) { Get-Content -LiteralPath $env | ForEach-Object { if ($_ -match '^\\s*(export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=') { Write-Output ("UNO_K " + $d + [char]9 + $Matches[2]) } } | Select-Object -First ${MAX_KEYS} }`,
      `}`,
    ].join("\n");
  }
  const extras = extraDirs.map(shQuote).join(" ");
  return [
    `printf 'UNO_HOME %s\\n' "$HOME"`,
    `{ for d in "$HOME"/projects/*/; do d="\${d%/}"; [ -e "$d/.git" ] && printf '%s\\n' "$d"; done;${extras ? ` for d in ${extras}; do [ -d "$d" ] && printf '%s\\n' "$d"; done;` : ""} } 2>/dev/null | awk '!seen[$0]++' | head -n ${MAX_PROJECTS} | while IFS= read -r d; do`,
    `  if [ -e "$d/.git" ]; then g=1; else g=0; fi`,
    `  printf 'UNO_P %s\\t%s\\n' "$g" "$d"`,
    `  if [ -f "$d/.env" ]; then sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\\2/p' "$d/.env" | head -n ${MAX_KEYS} | while IFS= read -r k; do printf 'UNO_K %s\\t%s\\n' "$d" "$k"; done; fi`,
    `done`,
  ].join("\n");
}

export interface ParsedScan {
  readonly home: string | null;
  readonly projects: ReadonlyArray<{
    readonly path: string;
    readonly git: boolean;
    readonly keys: ReadonlyArray<string>;
  }>;
}

export function parseScan(text: string): ParsedScan {
  let home: string | null = null;
  const order: Array<string> = [];
  const found = new Map<string, { git: boolean; keys: Set<string> }>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("UNO_HOME ")) {
      home = line.slice("UNO_HOME ".length).trim() || null;
    } else if (line.startsWith("UNO_P ")) {
      const rest = line.slice("UNO_P ".length);
      const tab = rest.indexOf("\t");
      if (tab < 0) continue;
      const dir = rest.slice(tab + 1).trim();
      if (dir.length === 0 || found.has(dir)) continue;
      order.push(dir);
      found.set(dir, { git: rest.slice(0, tab).trim() === "1", keys: new Set() });
    } else if (line.startsWith("UNO_K ")) {
      const rest = line.slice("UNO_K ".length);
      const tab = rest.lastIndexOf("\t");
      if (tab < 0) continue;
      const entry = found.get(rest.slice(0, tab).trim());
      const name = rest.slice(tab + 1).trim();
      if (entry && ENV_NAME.test(name) && entry.keys.size < MAX_KEYS) entry.keys.add(name);
    }
  }
  return {
    home,
    projects: order.map((dir) => ({
      path: dir,
      git: found.get(dir)!.git,
      keys: [...found.get(dir)!.keys].toSorted(),
    })),
  };
}

/** `~/projects/landing` for people. */
export function displayPathOf(dir: string, home: string | null): string {
  if (home && (dir === home || dir.startsWith(`${home}/`) || dir.startsWith(`${home}\\`))) {
    return `~${dir.slice(home.length).replace(/\\/g, "/")}`;
  }
  return dir;
}

export const folderName = (dir: string): string =>
  dir
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || "project";

// ── Reading chosen keys (values) ───────────────────────────────────────

/** Prints only the chosen keys' lines of `<dir>/.env`. */
export function chosenKeysCommand(
  dir: string,
  names: ReadonlyArray<string>,
  windows: boolean,
): string {
  const safe = names.filter((name) => ENV_NAME.test(name));
  const alternation = safe.join("|");
  if (windows) {
    return `$f = Join-Path ${psQuote(dir)} '.env'; if (Test-Path -LiteralPath $f) { Get-Content -LiteralPath $f | Where-Object { $_ -match '^\\s*(export\\s+)?(${alternation})\\s*=' } }`;
  }
  return `f=${shQuote(`${dir}/.env`)}; [ -f "$f" ] && grep -E '^[[:space:]]*(export[[:space:]]+)?(${alternation})[[:space:]]*=' "$f" || true`;
}

/** `NAME=value` lines (dotenv style: quotes, `export`, trailing comments on bare values). */
export function parseEnvLines(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!match) continue;
    let value = match[2]!;
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values.set(match[1]!, value);
  }
  return values;
}

// ── The service core ───────────────────────────────────────────────────

export interface BringWorkDeps {
  readonly stateDir: string;
  /** `~` of this cloud computer (projects land in `~/projects`). */
  readonly home: string;
  readonly core: MyComputerCore;
  /** Folders found chats ran in on this computer (the chat import's index). */
  readonly chatFolders: (computerId: string) => Promise<ReadonlyArray<string>>;
  /** A Work project for `folder` here: its id (made when missing). */
  readonly projectFor: (folder: string, title: string) => Promise<string>;
  /** "On all my computers" on for the project. */
  readonly syncOn: (projectId: string) => Promise<void>;
  /** A key of the project: vault + `.env` here. */
  readonly setKey: (projectId: string, name: string, value: string) => Promise<void>;
  readonly warn?: (message: string) => void;
}

interface BroughtRecord {
  /** Path on the computer → folder here. */
  readonly folders: Record<string, string>;
}

const idleBring = (): ComputerWorkStatus["bring"] => ({
  state: "idle",
  done: 0,
  total: 0,
  message: null,
  results: [],
});

export function createBringWork(deps: BringWorkDeps) {
  const scans = new Map<string, ComputerWorkStatus["scan"]>();
  const brings = new Map<string, ComputerWorkStatus["bring"]>();
  const running = new Map<string, Promise<void>>();

  const recordFile = (computerId: string) =>
    path.join(deps.stateDir, "my-computer", safeSegment(computerId), "brought.json");
  const readRecord = async (computerId: string): Promise<BroughtRecord> => {
    try {
      const parsed = JSON.parse(
        await fsp.readFile(recordFile(computerId), "utf8"),
      ) as Partial<BroughtRecord>;
      return { folders: { ...(parsed.folders ?? {}) } };
    } catch {
      return { folders: {} };
    }
  };

  const statusOf = (computerId: string): ComputerWorkStatus => ({
    computerId,
    scan: scans.get(computerId) ?? {
      state: "idle",
      message: null,
      scannedAt: null,
      home: null,
      projects: [],
    },
    bring: brings.get(computerId) ?? idleBring(),
  });

  const computerOf = async (computerId: string) => {
    const status = await deps.core.status();
    const computer = status.computers.find((entry) => entry.id === computerId);
    if (!status.enabled || computer === undefined) {
      throw new MyComputerFailure("remote", "This computer isn't connected any more.");
    }
    return computer;
  };

  const runScan = async (computerId: string) => {
    const startedAt = new Date().toISOString();
    try {
      const computer = await computerOf(computerId);
      if (!computer.online) {
        scans.set(computerId, {
          state: "failed",
          message: `${computer.name || "This computer"} is offline.`,
          scannedAt: startedAt,
          home: null,
          projects: [],
        });
        return;
      }
      const windows = computer.os === "windows";
      const extra = (await deps.chatFolders(computerId).catch(() => [])).filter(
        (dir) => dir.length > 0 && dir.length < 4096,
      );
      const result = await deps.core.exec({
        computerId,
        cmd: scanCommand(extra, windows),
        timeoutMs: SCAN_TIMEOUT_MS,
        maxOutputBytes: 512 * 1024,
      });
      const parsed = parseScan(result.text);
      const fromChats = new Set(extra);
      const brought = await readRecord(computerId);
      const projects: Array<FoundProject> = parsed.projects.map((entry) => ({
        name: folderName(entry.path),
        path: entry.path,
        displayPath: displayPathOf(entry.path, parsed.home),
        git: entry.git,
        keys: entry.keys,
        fromChats: fromChats.has(entry.path),
        synced: brought.folders[entry.path] !== undefined,
      }));
      scans.set(computerId, {
        state: "ready",
        message: null,
        scannedAt: new Date().toISOString(),
        home: parsed.home,
        projects,
      });
    } catch (cause) {
      scans.set(computerId, {
        state: "failed",
        message:
          cause instanceof MyComputerFailure
            ? cause.message
            : "Couldn't look for projects: the computer stopped answering.",
        scannedAt: startedAt,
        home: null,
        projects: [],
      });
    }
  };

  /** `~/projects/<name>`, or `<name>-2`… when another folder has the name. */
  const freeFolder = async (name: string): Promise<string> => {
    const base = path.join(deps.home, "projects", name.replace(/[^\w.@-]+/g, "-") || "project");
    for (let attempt = 1; attempt < 100; attempt++) {
      const candidate = attempt === 1 ? base : `${base}-${attempt}`;
      const exists = await fsp
        .stat(candidate)
        .then(() => true)
        .catch(() => false);
      if (!exists) return candidate;
    }
    throw new Error("No free folder name in ~/projects.");
  };

  const bringOne = async (
    computerId: string,
    windows: boolean,
    item: { readonly path: string; readonly keys: ReadonlyArray<string> },
  ): Promise<ComputerWorkStatus["bring"]["results"][number]> => {
    const name = folderName(item.path);
    const record = await readRecord(computerId);
    let folder = record.folders[item.path];
    if (folder !== undefined) {
      const stillThere = await fsp
        .stat(folder)
        .then((st) => st.isDirectory())
        .catch(() => false);
      if (!stillThere) folder = undefined;
    }
    if (folder === undefined) {
      folder = await freeFolder(name);
      await copyFolderFromComputer({
        core: deps.core,
        computerId,
        source: item.path,
        destination: folder,
      });
      record.folders[item.path] = folder;
      await writeJsonPrivately(recordFile(computerId), record);
    }
    const projectId = await deps.projectFor(folder, name);
    let syncMessage: string | null = null;
    await deps.syncOn(projectId).catch((cause) => {
      syncMessage = `Copied, but "On all my computers" didn't turn on: ${cause instanceof Error ? cause.message : String(cause)}`;
    });
    let keysSaved = 0;
    const names = item.keys.filter((key) => ENV_NAME.test(key));
    if (names.length > 0) {
      const read = await deps.core.exec({
        computerId,
        cmd: chosenKeysCommand(item.path, names, windows),
        timeoutMs: 30_000,
        maxOutputBytes: 256 * 1024,
      });
      const values = parseEnvLines(read.text);
      for (const key of names) {
        const value = values.get(key);
        if (value === undefined) continue;
        try {
          await deps.setKey(projectId, key, value);
          keysSaved += 1;
        } catch (cause) {
          // Never the value: the name and why.
          deps.warn?.(
            `bring work: key ${key} not saved: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
    }
    const missing = names.length - keysSaved;
    return {
      path: item.path,
      name,
      ok: syncMessage === null,
      keysSaved,
      message:
        syncMessage ??
        (missing > 0
          ? `${missing} of the chosen keys weren't saved. Add them in the project's keys.`
          : null),
    };
  };

  const runBring = async (
    computerId: string,
    projects: ReadonlyArray<{ readonly path: string; readonly keys: ReadonlyArray<string> }>,
  ) => {
    const state: {
      -readonly [K in keyof ComputerWorkStatus["bring"]]: ComputerWorkStatus["bring"][K];
    } = {
      state: "running",
      done: 0,
      total: projects.length,
      message: null,
      results: [],
    };
    brings.set(computerId, state);
    try {
      const computer = await computerOf(computerId);
      if (!computer.online)
        throw new MyComputerFailure("remote", `${computer.name || "This computer"} is offline.`);
      const windows = computer.os === "windows";
      const results: Array<ComputerWorkStatus["bring"]["results"][number]> = [];
      for (const item of projects) {
        try {
          results.push(await bringOne(computerId, windows, item));
        } catch (cause) {
          results.push({
            path: item.path,
            name: folderName(item.path),
            ok: false,
            keysSaved: 0,
            message: cause instanceof Error ? cause.message.slice(0, 400) : "It didn't work.",
          });
        }
        brings.set(computerId, { ...state, done: results.length, results: [...results] });
      }
      brings.set(computerId, {
        state: "done",
        done: results.length,
        total: projects.length,
        message: null,
        results,
      });
      // The scan's "synced" marks follow.
      const scan = scans.get(computerId);
      if (scan) {
        const record = await readRecord(computerId);
        scans.set(computerId, {
          ...scan,
          projects: scan.projects.map((entry) => ({
            ...entry,
            synced: record.folders[entry.path] !== undefined,
          })),
        });
      }
    } catch (cause) {
      brings.set(computerId, {
        ...state,
        state: "failed",
        message: cause instanceof Error ? cause.message : "It didn't work.",
      });
    }
  };

  return {
    status: async (computerId: string) => statusOf(computerId),
    scan: async (computerId: string) => {
      const scan = scans.get(computerId);
      const fresh =
        scan?.state === "ready" &&
        scan.scannedAt !== null &&
        Date.now() - Date.parse(scan.scannedAt) < SCAN_FRESH_MS;
      if (!fresh && scan?.state !== "scanning" && !running.has(`scan:${computerId}`)) {
        scans.set(computerId, {
          state: "scanning",
          message: null,
          scannedAt: scan?.scannedAt ?? null,
          home: scan?.home ?? null,
          projects: scan?.projects ?? [],
        });
        const job = runScan(computerId).finally(() => running.delete(`scan:${computerId}`));
        running.set(`scan:${computerId}`, job);
      }
      return statusOf(computerId);
    },
    bring: async (
      computerId: string,
      projects: ReadonlyArray<{ readonly path: string; readonly keys: ReadonlyArray<string> }>,
    ) => {
      if (!running.has(`bring:${computerId}`) && projects.length > 0) {
        const job = runBring(computerId, projects).finally(() =>
          running.delete(`bring:${computerId}`),
        );
        running.set(`bring:${computerId}`, job);
        // The first state is set synchronously inside runBring.
      }
      return statusOf(computerId);
    },
    /** The folder here a computer's project was brought to, if it was. */
    broughtFolder: async (computerId: string, dir: string) =>
      (await readRecord(computerId)).folders[dir] ?? null,
    /** Remember a folder copied by someone else (Continue in the cloud). */
    rememberFolder: async (computerId: string, dir: string, folder: string) => {
      const record = await readRecord(computerId);
      record.folders[dir] = folder;
      await writeJsonPrivately(recordFile(computerId), record);
    },
    freeFolder,
  };
}

export type BringWork = ReturnType<typeof createBringWork>;
