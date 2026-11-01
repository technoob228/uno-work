/**
 * Finds the chats on a computer through the tunnel: which programs are there,
 * what sessions they hold, and just enough of each to name it. Big files are
 * read at the start and the end; a broken or unknown file is counted and
 * skipped. The result stays in memory until the person agrees to import.
 *
 * @module myComputer/import/chatScan
 */
import { promisify } from "node:util";
import * as zlib from "node:zlib";

import type { ImportedChatTool } from "@t3tools/contracts";

import {
  appMarkers,
  claudeSessionId,
  codexSessionId,
  environmentProbe,
  isZstdPath,
  joinPath,
  osOf,
  parseEnvironmentProbe,
  resolveChatRoots,
  type ChatEnvironment,
  type ChatRoots,
  type ComputerOs,
} from "./chatPaths.ts";
import { peekClaudeSession } from "./claudeSessions.ts";
import { parseCodexIndex, peekCodexSession } from "./codexSessions.ts";
import { isFileFailure, type ComputerAccess, type ListEntry } from "./computerAccess.ts";
import {
  OPENCODE_PAGE_ROWS,
  openCodeDbCommand,
  parseSessionRow,
  parseSqlOutput,
  readOpenCodeSchema,
  sessionsPageSql,
  sqlite3Command,
  type OpenCodeSchema,
  type SqlRunner,
} from "./openCodeSessions.ts";
import {
  PEEK_HEAD_BYTES,
  PEEK_TAIL_BYTES,
  fallbackTitle,
  isoDate,
  type PeekResult,
  type SessionPeek,
} from "./sessionText.ts";

/** The helper takes 32 operations at a time; leave room for an agent's work. */
const READ_CONCURRENCY = 12;
const PROBE_TIMEOUT_MS = 20_000;
const SQL_TIMEOUT_MS = 60_000;
/** A page of `sqlite3 -json`; the agent's 64 KB would cut it. */
export const SQL_OUTPUT_BYTES = 8 * 1024 * 1024;
const CODEX_INDEX_MAX_BYTES = 2 * 1024 * 1024;
/** A compressed head: zstd packs these files about tenfold. */
const ZSTD_HEAD_BYTES = 128 * 1024;

export interface ScannedChat {
  readonly tool: ImportedChatTool;
  readonly sessionId: string;
  readonly path: string;
  readonly title: string;
  /** False when the title is our own fallback, not the session's. */
  readonly titled: boolean;
  readonly cwd: string | null;
  readonly startedAt: string;
  readonly lastActiveAt: string;
  /** Changes when the session changes; unchanged sessions aren't read again. */
  readonly fingerprint: string;
}

export interface ToolScan {
  readonly tool: ImportedChatTool;
  readonly chats: ReadonlyArray<ScannedChat>;
  /** False: chats may be there, but this computer gives no way to read them. */
  readonly available: boolean;
  readonly unavailableReason: string | null;
}

export interface ScanResult {
  readonly tools: ReadonlyArray<ToolScan>;
  readonly alsoFound: ReadonlyArray<string>;
  readonly skipped: { readonly unreadable: number; readonly unknownFormat: number };
}

export interface ComputerProbe {
  readonly os: ComputerOs;
  readonly home: string;
  readonly env: ChatEnvironment;
  readonly roots: ChatRoots;
}

export interface ScanOptions {
  readonly access: ComputerAccess;
  /** An already imported chat this fingerprint matches: no need to read it again. */
  readonly known: (input: {
    readonly tool: ImportedChatTool;
    readonly sessionId: string;
    readonly fingerprint: string;
  }) => ScannedChat | null;
  readonly onProgress: (done: number, total: number) => void;
}

/** Runs `work` over `items`, a few at a time; the first failure stops it all. */
export async function mapPool<T>(
  items: ReadonlyArray<T>,
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function probeComputer(access: ComputerAccess): Promise<ComputerProbe> {
  const info = await access.info();
  const os = osOf(info.os);
  let env = parseEnvironmentProbe("");
  try {
    const answer = await access.exec({
      cmd: environmentProbe(os),
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: 8 * 1024,
    });
    if (answer.exitCode === 0) env = parseEnvironmentProbe(answer.text);
  } catch (cause) {
    if (!isFileFailure(cause)) throw cause;
  }
  return { os, home: info.home, env, roots: resolveChatRoots({ os, home: info.home, env }) };
}

/** How this computer can read OpenCode's database, or null when it can't. */
export function openCodeRunner(
  access: ComputerAccess,
  probe: ComputerProbe,
  dbPath: string,
): SqlRunner | null {
  if (!probe.env.hasSqlite3 && !probe.env.hasOpenCode) return null;
  const run = async (cmd: string) => {
    const answer = await access.exec({
      cmd,
      timeoutMs: SQL_TIMEOUT_MS,
      maxOutputBytes: SQL_OUTPUT_BYTES,
    });
    if (answer.exitCode !== 0 || answer.cutBytes > 0) return null;
    return parseSqlOutput(answer.text);
  };
  return async (sql) => {
    if (probe.env.hasSqlite3) {
      const rows = await run(sqlite3Command(probe.os, dbPath, sql));
      if (rows !== null) return rows;
    }
    if (probe.env.hasOpenCode) {
      const rows = await run(openCodeDbCommand(probe.os, sql));
      if (rows !== null) return rows;
    }
    throw new Error("OpenCode's database didn't answer.");
  };
}

const unzstd = promisify(zlib.zstdDecompress);

export const canReadZstd = () => typeof zlib.zstdDecompress === "function";

export async function decompressZstd(data: Buffer): Promise<Buffer> {
  return Buffer.from(await unzstd(data));
}

/** As much as a cut-off zstd stream gives. Nothing at all means it is broken. */
function decompressZstdHead(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const stream = zlib.createZstdDecompress();
    const pieces: Array<Buffer> = [];
    let total = 0;
    const finish = () => {
      stream.destroy();
      if (total === 0) reject(new Error("Not a zstd stream."));
      else resolve(Buffer.concat(pieces));
    };
    stream.on("data", (chunk: Buffer) => {
      pieces.push(chunk);
      total += chunk.length;
      if (total >= PEEK_HEAD_BYTES) finish();
    });
    stream.on("error", finish);
    stream.on("end", finish);
    stream.end(data);
  });
}

async function peekFile(
  access: ComputerAccess,
  file: { readonly path: string; readonly size: number },
): Promise<SessionPeek> {
  if (isZstdPath(file.path)) {
    const raw = await access.read({ path: file.path, offset: 0, maxBytes: ZSTD_HEAD_BYTES });
    const head = (await decompressZstdHead(raw.data)).subarray(0, PEEK_HEAD_BYTES);
    return { head: head.toString("utf8"), tail: null, headCut: head.length >= PEEK_HEAD_BYTES };
  }
  const head = await access.read({ path: file.path, offset: 0, maxBytes: PEEK_HEAD_BYTES });
  if (head.eof || file.size <= PEEK_HEAD_BYTES) {
    return { head: head.data.toString("utf8"), tail: null, headCut: false };
  }
  const offset = Math.max(PEEK_HEAD_BYTES, file.size - PEEK_TAIL_BYTES);
  const tail = await access.read({ path: file.path, offset, maxBytes: PEEK_TAIL_BYTES });
  return { head: head.data.toString("utf8"), tail: tail.data.toString("utf8"), headCut: true };
}

interface SessionFile {
  readonly tool: "claude" | "codex";
  readonly sessionId: string;
  readonly path: string;
  readonly size: number;
  readonly mtime: string | null;
}

const toFile = (
  tool: "claude" | "codex",
  folder: string,
  os: ComputerOs,
  entry: ListEntry,
): SessionFile | null => {
  // `list` reports a symlink as a symlink: only plain files are sessions.
  if (entry.type !== "file") return null;
  const sessionId = tool === "claude" ? claudeSessionId(entry.name) : codexSessionId(entry.name);
  if (sessionId === null) return null;
  return {
    tool,
    sessionId,
    path: joinPath(os, folder, entry.name),
    size: entry.size,
    mtime: entry.mtime,
  };
};

/** A folder that isn't there is a program that isn't installed. */
async function listOrEmpty(
  access: ComputerAccess,
  path: string,
): Promise<ReadonlyArray<ListEntry>> {
  try {
    return (await access.list(path)).entries;
  } catch (cause) {
    if (isFileFailure(cause)) return [];
    throw cause;
  }
}

async function listClaudeFiles(
  access: ComputerAccess,
  probe: ComputerProbe,
): Promise<Array<SessionFile>> {
  const root = probe.roots.claudeProjects;
  const folders = (await listOrEmpty(access, root)).filter((entry) => entry.type === "dir");
  const files: Array<SessionFile> = [];
  await mapPool(folders, READ_CONCURRENCY, async (folder) => {
    const path = joinPath(probe.os, root, folder.name);
    for (const entry of await listOrEmpty(access, path)) {
      const file = toFile("claude", path, probe.os, entry);
      if (file !== null) files.push(file);
    }
  });
  return files;
}

async function listCodexFiles(
  access: ComputerAccess,
  probe: ComputerProbe,
): Promise<Array<SessionFile>> {
  const digits = (length: number) => (entry: ListEntry) =>
    entry.type === "dir" && entry.name.length === length && /^\d+$/.test(entry.name);
  const dive = async (paths: ReadonlyArray<string>, length: number) => {
    const found: Array<string> = [];
    await mapPool(paths, READ_CONCURRENCY, async (path) => {
      for (const entry of await listOrEmpty(access, path)) {
        if (digits(length)(entry)) found.push(joinPath(probe.os, path, entry.name));
      }
    });
    return found;
  };
  const years = await dive([probe.roots.codexSessions], 4);
  const months = await dive(years, 2);
  const days = await dive(months, 2);
  const newest = new Map<string, SessionFile>();
  await mapPool(days, READ_CONCURRENCY, async (path) => {
    for (const entry of await listOrEmpty(access, path)) {
      const file = toFile("codex", path, probe.os, entry);
      if (file === null) continue;
      // A resumed thread can leave several files: the newest holds the rest.
      const held = newest.get(file.sessionId);
      if (held === undefined || (file.mtime ?? "") > (held.mtime ?? "")) {
        newest.set(file.sessionId, file);
      }
    }
  });
  return [...newest.values()];
}

async function readCodexIndex(
  access: ComputerAccess,
  probe: ComputerProbe,
): Promise<ReadonlyMap<string, string>> {
  try {
    const answer = await access.read({
      path: probe.roots.codexIndex,
      offset: 0,
      maxBytes: CODEX_INDEX_MAX_BYTES,
    });
    return parseCodexIndex(answer.data.toString("utf8"));
  } catch (cause) {
    if (isFileFailure(cause)) return new Map();
    throw cause;
  }
}

async function scanOpenCode(
  access: ComputerAccess,
  probe: ComputerProbe,
): Promise<{ readonly scan: ToolScan; readonly unknownFormat: number }> {
  const unavailable = (reason: string, chats = 0) => ({
    scan: {
      tool: "opencode" as const,
      chats: [],
      available: false,
      unavailableReason: reason,
    },
    unknownFormat: chats,
  });
  const none = {
    scan: { tool: "opencode" as const, chats: [], available: true, unavailableReason: null },
    unknownFormat: 0,
  };
  const path = probe.roots.openCodeDb;
  const stat = await access.stat(path).catch((cause: unknown) => {
    if (isFileFailure(cause)) return null;
    throw cause;
  });
  if (stat === null || !stat.exists) return none;
  const run = openCodeRunner(access, probe, path);
  if (run === null) return unavailable("needs sqlite3 on this computer");
  let schema: OpenCodeSchema | null;
  try {
    schema = await readOpenCodeSchema(run);
  } catch {
    return unavailable("couldn't read its chats");
  }
  if (schema === null) return unavailable("this version isn't supported yet");
  const chats: Array<ScannedChat> = [];
  let unknownFormat = 0;
  for (let offset = 0; ; offset += OPENCODE_PAGE_ROWS) {
    const rows = await run(sessionsPageSql(schema, offset));
    for (const row of rows) {
      const chat = parseSessionRow(row);
      if (chat === null || chat.startedAt === null || chat.lastActiveAt === null) {
        unknownFormat += 1;
        continue;
      }
      chats.push({
        tool: "opencode",
        sessionId: chat.sessionId,
        path,
        title: chat.title ?? fallbackTitle("opencode", chat.lastActiveAt),
        titled: chat.title !== null,
        cwd: chat.cwd,
        startedAt: chat.startedAt,
        lastActiveAt: chat.lastActiveAt,
        fingerprint: chat.fingerprint,
      });
    }
    if (rows.length < OPENCODE_PAGE_ROWS) break;
  }
  return {
    scan: { tool: "opencode", chats, available: true, unavailableReason: null },
    unknownFormat,
  };
}

function toScannedChat(
  file: SessionFile,
  result: Extract<PeekResult, { kind: "chat" }>,
  fingerprint: string,
  codexNames: ReadonlyMap<string, string>,
): ScannedChat | null {
  const lastActiveAt = result.lastActiveAt ?? isoDate(file.mtime) ?? result.startedAt;
  if (lastActiveAt === null) return null;
  const title = (file.tool === "codex" ? codexNames.get(file.sessionId) : null) ?? result.title;
  return {
    tool: file.tool,
    sessionId: file.sessionId,
    path: file.path,
    title: title ?? fallbackTitle(file.tool, lastActiveAt),
    titled: title !== null,
    cwd: result.cwd,
    startedAt: result.startedAt ?? lastActiveAt,
    lastActiveAt,
    fingerprint,
  };
}

async function foundApps(
  access: ComputerAccess,
  probe: ComputerProbe,
): Promise<ReadonlyArray<string>> {
  const found: Array<string> = [];
  for (const app of appMarkers({ os: probe.os, home: probe.home })) {
    for (const path of app.paths) {
      const stat = await access.stat(path).catch((cause: unknown) => {
        if (isFileFailure(cause)) return null;
        throw cause;
      });
      if (stat?.exists === true) {
        found.push(app.name);
        break;
      }
    }
  }
  return found;
}

export async function scanComputer(options: ScanOptions): Promise<ScanResult> {
  const { access, known, onProgress } = options;
  const probe = await probeComputer(access);
  const [claudeFiles, codexFiles, codexNames] = await Promise.all([
    listClaudeFiles(access, probe),
    listCodexFiles(access, probe),
    readCodexIndex(access, probe),
  ]);
  const openCode = await scanOpenCode(access, probe);
  const files = [...claudeFiles, ...codexFiles];
  const alsoFound = await foundApps(access, probe);

  const found: Record<"claude" | "codex", Array<ScannedChat>> = { claude: [], codex: [] };
  let unreadable = 0;
  let unknownFormat = openCode.unknownFormat;
  let done = 0;
  const total = files.length;
  onProgress(0, total);
  await mapPool(files, READ_CONCURRENCY, async (file) => {
    try {
      const fingerprint = `${file.size}:${file.mtime ?? ""}`;
      const held = known({ tool: file.tool, sessionId: file.sessionId, fingerprint });
      if (held !== null) {
        found[file.tool].push(held);
        return;
      }
      let result: PeekResult;
      try {
        const peek = await peekFile(access, file);
        result = file.tool === "claude" ? peekClaudeSession(peek) : peekCodexSession(peek);
      } catch (cause) {
        if (isFileFailure(cause) || (cause instanceof Error && !("kind" in cause))) {
          unreadable += 1;
          return;
        }
        throw cause;
      }
      if (result.kind === "broken") unreadable += 1;
      else if (result.kind === "unknown-format") unknownFormat += 1;
      else if (result.kind === "chat") {
        const chat = toScannedChat(file, result, fingerprint, codexNames);
        if (chat === null) unknownFormat += 1;
        else found[file.tool].push(chat);
      }
    } finally {
      done += 1;
      onProgress(done, total);
    }
  });

  const newestFirst = (chats: ReadonlyArray<ScannedChat>) =>
    chats.toSorted((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
  return {
    tools: [
      {
        tool: "claude",
        chats: newestFirst(found.claude),
        available: true,
        unavailableReason: null,
      },
      {
        tool: "codex",
        chats: newestFirst(found.codex),
        available: true,
        unavailableReason: null,
      },
      { ...openCode.scan, chats: newestFirst(openCode.scan.chats) },
    ],
    alsoFound,
    skipped: { unreadable, unknownFormat },
  };
}
