/**
 * The file half of moving an assistant between computers
 * (`@t3tools/shared/assistantMove`): its folder and its daemon state read
 * into bundle files and written back on the other computer, the text copy of
 * its chats, and the record of moves (`<state>/assistants/moves.json`) that
 * makes every step undoable.
 *
 * Plain async I/O, no Effect, so it is unit-tested directly.
 *
 * @module assistants/assistantMoveFiles
 */
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";

import type {
  AssistantMoveComputer,
  AssistantMoveFile,
  AssistantMoveReminder,
} from "@t3tools/shared/assistantMove";

/** One file bigger than this stays where it is (named in the result). */
export const MOVE_FILE_LIMIT_BYTES = 8 * 1024 * 1024;
/** The whole bundle's files; past it the rest stays (named in the result). */
export const MOVE_TOTAL_LIMIT_BYTES = 48 * 1024 * 1024;
/** The text copy of its chats, all of them together. */
export const MOVE_HISTORY_LIMIT_BYTES = 3 * 1024 * 1024;
export const MOVE_HISTORY_MAX_CHATS = 60;

/** Written by the daemon for this computer; never carried over. */
const COMPUTER_OWN_FILES = new Set([".mcp.json", ".uno-assistant.json"]);
/** Caches and checkouts that are rebuilt, not memory. */
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".venv", "__pycache__", ".cache"]);

export interface CollectedFiles {
  readonly files: AssistantMoveFile[];
  readonly skipped: Array<{ readonly path: string; readonly reason: string }>;
  readonly bytes: number;
}

/**
 * Every regular file under `root` (relative paths, `/`-separated), skipping
 * the computer's own files, caches, symlinks and what doesn't fit the limits.
 * A missing root is an empty folder.
 */
export async function collectFiles(
  root: string,
  input: { readonly budgetBytes?: number; readonly skipTop?: ReadonlyArray<string> } = {},
): Promise<CollectedFiles> {
  const files: AssistantMoveFile[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let bytes = 0;
  const budget = input.budgetBytes ?? MOVE_TOTAL_LIMIT_BYTES;
  const skipTop = new Set(input.skipTop ?? []);

  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (prefix.length === 0 && (COMPUTER_OWN_FILES.has(entry.name) || skipTop.has(entry.name))) {
        continue;
      }
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        await walk(full, relative);
        continue;
      }
      if (!entry.isFile()) {
        if (entry.isSymbolicLink()) skipped.push({ path: relative, reason: "a link" });
        continue;
      }
      const stat = await fsp.stat(full).catch(() => null);
      if (stat === null) continue;
      if (stat.size > MOVE_FILE_LIMIT_BYTES) {
        skipped.push({ path: relative, reason: "over 8 MB" });
        continue;
      }
      if (bytes + stat.size > budget) {
        skipped.push({ path: relative, reason: "past the 48 MB a move carries" });
        continue;
      }
      const data = await fsp.readFile(full).catch(() => null);
      if (data === null) continue;
      bytes += data.length;
      files.push({ path: relative, mode: stat.mode & 0o777, data: data.toString("base64") });
    }
  };
  await walk(root, "");
  return { files, skipped, bytes };
}

/** A bundle path that stays inside its root, or null (absolute, `..`, NUL, empty). */
export function safeRelativePath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) return null;
  if (raw.includes("\0") || raw.includes("\\")) return null;
  if (raw.startsWith("/")) return null;
  const parts = raw.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return parts.join("/");
}

/** Writes bundle files under `root`; returns how many were written. Unsafe paths are refused. */
export async function writeFiles(
  root: string,
  files: ReadonlyArray<AssistantMoveFile>,
): Promise<number> {
  let written = 0;
  for (const file of files) {
    const relative = safeRelativePath(file.path);
    if (relative === null) throw new Error(`Refused a file outside the assistant: ${file.path}`);
    if (COMPUTER_OWN_FILES.has(relative)) continue;
    const target = nodePath.join(root, ...relative.split("/"));
    await fsp.mkdir(nodePath.dirname(target), { recursive: true });
    // The mode keeps owner-only files owner-only; never executable bits beyond rwx.
    const mode = Number.isInteger(file.mode) ? file.mode & 0o777 : 0o644;
    await fsp.writeFile(target, Buffer.from(file.data, "base64"), { mode: mode || 0o644 });
    await fsp.chmod(target, mode || 0o644).catch(() => undefined);
    written += 1;
  }
  return written;
}

// ── The text copy of its chats ────────────────────────────────────────

export interface HistoryChat {
  readonly title: string;
  readonly createdAt: string;
  readonly messages: ReadonlyArray<{
    readonly role: string;
    readonly text: string;
    readonly createdAt: string;
  }>;
}

const fileSafe = (text: string) =>
  text
    .replace(/[\\/:*?"<>|\u0000\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60) || "chat";

/**
 * Its chats as markdown files under `history/<computer>/` (newest first,
 * within {@link MOVE_HISTORY_LIMIT_BYTES}), plus a README saying where the
 * real ones are. Empty chats are left out.
 */
export function historyFiles(input: {
  readonly assistantName: string;
  readonly computerName: string;
  readonly movedAt: string;
  readonly chats: ReadonlyArray<HistoryChat>;
}): { readonly files: AssistantMoveFile[]; readonly chats: number } {
  const folder = `history/${fileSafe(input.computerName)}`;
  const files: AssistantMoveFile[] = [];
  const used = new Set<string>();
  let bytes = 0;
  let chats = 0;
  for (const chat of input.chats) {
    if (chats >= MOVE_HISTORY_MAX_CHATS) break;
    const spoken = chat.messages.filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") && message.text.trim().length > 0,
    );
    if (spoken.length === 0) continue;
    const lines = [
      `# ${chat.title.trim() || "Chat"}`,
      "",
      `With ${input.assistantName} on ${input.computerName}, from ${chat.createdAt.slice(0, 10)}.`,
      "",
    ];
    for (const message of spoken) {
      const who = message.role === "user" ? "You" : input.assistantName;
      lines.push(
        `**${who}** · ${message.createdAt.slice(0, 16).replace("T", " ")}`,
        "",
        message.text.trim(),
        "",
      );
    }
    const text = `${lines.join("\n")}\n`;
    const size = Buffer.byteLength(text, "utf8");
    if (bytes + size > MOVE_HISTORY_LIMIT_BYTES) break;
    let name = `${chat.createdAt.slice(0, 10)} ${fileSafe(chat.title)}`;
    for (let n = 2; used.has(name); n += 1)
      name = `${chat.createdAt.slice(0, 10)} ${fileSafe(chat.title)} ${n}`;
    used.add(name);
    files.push({
      path: `${folder}/${name}.md`,
      mode: 0o600,
      data: Buffer.from(text).toString("base64"),
    });
    bytes += size;
    chats += 1;
  }
  if (chats > 0) {
    const readme = [
      `# Chats from ${input.computerName}`,
      "",
      `${input.assistantName} moved here from ${input.computerName} on ${input.movedAt.slice(0, 10)}.`,
      `These are text copies of its chats there (newest ${chats}); the chats themselves stay readable on ${input.computerName}.`,
      "",
    ].join("\n");
    files.push({
      path: `${folder}/README.md`,
      mode: 0o600,
      data: Buffer.from(readme).toString("base64"),
    });
  }
  return { files, chats };
}

// ── The record of moves ───────────────────────────────────────────────

export interface ConnectorRowCopy {
  readonly kind: "telegram" | "slack";
  readonly config: unknown;
}

/** This computer let an assistant go (Undo brings it back). */
export interface OutgoingMove {
  readonly projectId: string;
  readonly to: AssistantMoveComputer;
  readonly at: string;
  readonly isUno: boolean;
  /** A named assistant went to Deleted (kept 7 days); Uno stays, without channels. */
  readonly deleted: boolean;
  readonly connectorRows: ReadonlyArray<ConnectorRowCopy>;
  readonly reminders: ReadonlyArray<AssistantMoveReminder>;
}

/** An assistant came to this computer: staged until activated. */
export interface IncomingMove {
  readonly projectId: string;
  readonly from: AssistantMoveComputer;
  readonly at: string;
  readonly stage: "staged" | "active";
  readonly isUno: boolean;
  /** The project was made by the import (a named assistant new here). */
  readonly created: boolean;
  /** What this computer's own Uno was before the move (Uno only). */
  readonly backup: {
    readonly workspaceRoot: string;
    readonly workspaceBackup: string | null;
    readonly stateBackup: string | null;
    readonly title: string;
    readonly defaultModelSelection: unknown;
    readonly connectorRows: ReadonlyArray<ConnectorRowCopy>;
  } | null;
  /** Kinds the activation wrote (the discard removes / restores exactly these). */
  readonly activated: ReadonlyArray<"telegram" | "slack">;
  readonly reminderIds: ReadonlyArray<string>;
}

export interface MovesRecord {
  readonly outgoing: Readonly<Record<string, OutgoingMove>>;
  readonly incoming: Readonly<Record<string, IncomingMove>>;
}

const EMPTY_RECORD: MovesRecord = { outgoing: {}, incoming: {} };

export const movesFile = (stateDir: string) => nodePath.join(stateDir, "assistants", "moves.json");
/** Where this computer's Uno state waits while another Uno moves in (Uno only). */
export const moveBackupDir = (stateDir: string) =>
  nodePath.join(stateDir, "assistants", ".move-backup");
/** An assistant's daemon state on this computer. */
export const assistantStateDir = (stateDir: string, projectId: string) =>
  nodePath.join(stateDir, "assistants", encodeURIComponent(projectId));

let queue: Promise<unknown> = Promise.resolve();

export async function readMoves(stateDir: string): Promise<MovesRecord> {
  try {
    const raw = JSON.parse(await fsp.readFile(movesFile(stateDir), "utf8")) as Partial<MovesRecord>;
    return {
      outgoing: typeof raw.outgoing === "object" && raw.outgoing !== null ? raw.outgoing : {},
      incoming: typeof raw.incoming === "object" && raw.incoming !== null ? raw.incoming : {},
    };
  } catch {
    return EMPTY_RECORD;
  }
}

/** Read-modify-write of the record, one at a time; the file is owner-only (it holds bot tokens). */
export function updateMoves(
  stateDir: string,
  change: (record: MovesRecord) => MovesRecord,
): Promise<MovesRecord> {
  const task = async () => {
    const next = change(await readMoves(stateDir));
    const file = movesFile(stateDir);
    await fsp.mkdir(nodePath.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(temporary, file);
    return next;
  };
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

/** The mark the assistants list shows for one assistant (null: it never moved). */
export function moveMarkOf(
  record: MovesRecord,
  projectId: string,
): {
  readonly movedTo: {
    readonly boxId: number | null;
    readonly name: string;
    readonly at: string;
  } | null;
  readonly movedInAt: string | null;
  readonly movedFrom: string | null;
} | null {
  const outgoing = record.outgoing[projectId];
  const incoming = record.incoming[projectId];
  const active = incoming !== undefined && incoming.stage === "active" ? incoming : undefined;
  if (outgoing === undefined && active === undefined) return null;
  // The newer of the two wins: it moved away and came back, or the other way.
  if (outgoing !== undefined && (active === undefined || outgoing.at > active.at)) {
    return {
      movedTo: { boxId: outgoing.to.boxId, name: outgoing.to.name, at: outgoing.at },
      movedInAt: null,
      movedFrom: null,
    };
  }
  return { movedTo: null, movedInAt: active!.at, movedFrom: active!.from.name };
}

/** Moves a path aside to `<dir>/<name>__<stamp>`; returns where, or null when there was nothing. */
export async function putAside(path: string, dir: string, name: string): Promise<string | null> {
  const exists = await fsp
    .access(path)
    .then(() => true)
    .catch(() => false);
  if (!exists) return null;
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = nodePath.join(dir, `${encodeURIComponent(name)}__${stamp}`);
  await fsp.rename(path, target);
  return target;
}
