/**
 * Files of "a cloud chat asks to start a chat here" on the person's own
 * computer:
 *
 * - the request folder `~/.uno-work/chat-requests/` (`in/`, `out/`,
 *   `decisions/`, `state.json`), written by the cloud daemon through the "Connect my
 *   computer" tunnel and by Uno Work here (contracts chatRequests.ts);
 * - Uno Work's own record of them, `<stateDir>/chat-requests/requests.json`,
 *   with the chats held to the rules (`guarded`), and the journal of
 *   requests and decisions `journal.jsonl` next to it.
 *
 * Writes go through a temporary file and a rename: the other side never
 * reads half a file.
 *
 * @module chatRequests/spool
 */
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import path from "node:path";

import type { ChatRequestAnswer, ChatRequestsHostState } from "@t3tools/contracts";

import { EMPTY_HOST_STORE, parseHostStore, type HostRecord, type HostStore } from "./hostLogic.ts";

/** A request file bigger than this isn't one (20 000 characters of brief fit easily). */
export const MAX_REQUEST_FILE_BYTES = 256 * 1024;
const ID_FILE = /^([A-Za-z0-9_-]{1,64})\.json$/;

export interface SpoolPaths {
  readonly root: string;
  readonly incoming: string;
  readonly outgoing: string;
  /** Start / Decline pressed in the person's Telegram, written by the cloud daemon. */
  readonly decisions: string;
  readonly state: string;
}

export function spoolPaths(home: string = os.homedir()): SpoolPaths {
  const root = path.join(home, ".uno-work", "chat-requests");
  return {
    root,
    incoming: path.join(root, "in"),
    outgoing: path.join(root, "out"),
    decisions: path.join(root, "decisions"),
    state: path.join(root, "state.json"),
  };
}

export function storePaths(stateDir: string) {
  const dir = path.join(stateDir, "chat-requests");
  return { dir, store: path.join(dir, "requests.json"), journal: path.join(dir, "journal.jsonl") };
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fsp.writeFile(tmp, text, { mode: 0o600 });
  await fsp.rename(tmp, file);
}

export async function ensureSpool(paths: SpoolPaths): Promise<void> {
  await fsp.mkdir(paths.incoming, { recursive: true, mode: 0o700 });
  await fsp.mkdir(paths.outgoing, { recursive: true, mode: 0o700 });
  await fsp.mkdir(paths.decisions, { recursive: true, mode: 0o700 });
}

/** A decision file is a few lines; anything bigger isn't one. */
const MAX_DECISION_FILE_BYTES = 4 * 1024;

/** Decisions from the person's Telegram waiting in `decisions/`, by request id. */
export async function listDecisions(paths: SpoolPaths): Promise<ReadonlyArray<string>> {
  const names = await fsp.readdir(paths.decisions).catch(() => [] as Array<string>);
  return names
    .map((name) => ID_FILE.exec(name)?.[1] ?? null)
    .filter((id): id is string => id !== null)
    .toSorted();
}

/**
 * One decision file: its JSON and when it landed here (this computer's clock,
 * so a cloud clock that is off doesn't matter); null when it isn't one.
 */
export async function readDecision(
  paths: SpoolPaths,
  id: string,
): Promise<{ readonly raw: unknown; readonly writtenAtMs: number } | null> {
  const file = path.join(paths.decisions, `${id}.json`);
  const stat = await fsp.lstat(file).catch(() => null);
  if (stat === null || !stat.isFile() || stat.size > MAX_DECISION_FILE_BYTES) return null;
  const text = await fsp.readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return { raw: JSON.parse(text) as unknown, writtenAtMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

export async function removeDecision(paths: SpoolPaths, id: string): Promise<void> {
  await fsp.rm(path.join(paths.decisions, `${id}.json`), { force: true });
}

/** Request files waiting in `in/`, by id. Temporary files and strangers are left alone. */
export async function listIncoming(paths: SpoolPaths): Promise<ReadonlyArray<string>> {
  const names = await fsp.readdir(paths.incoming).catch(() => [] as Array<string>);
  return names
    .map((name) => ID_FILE.exec(name)?.[1] ?? null)
    .filter((id): id is string => id !== null)
    .toSorted();
}

/** One request file: its JSON, or null when it isn't one (too big, not JSON, not a file). */
export async function readIncoming(paths: SpoolPaths, id: string): Promise<unknown> {
  const file = path.join(paths.incoming, `${id}.json`);
  const stat = await fsp.lstat(file).catch(() => null);
  if (stat === null || !stat.isFile() || stat.size > MAX_REQUEST_FILE_BYTES) return null;
  const text = await fsp.readFile(file, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export async function removeIncoming(paths: SpoolPaths, id: string): Promise<void> {
  await fsp.rm(path.join(paths.incoming, `${id}.json`), { force: true });
}

export async function writeAnswer(paths: SpoolPaths, answer: ChatRequestAnswer): Promise<void> {
  await writeAtomic(
    path.join(paths.outgoing, `${answer.id}.json`),
    JSON.stringify(answer, null, 2),
  );
}

export async function writeHostState(
  paths: SpoolPaths,
  state: ChatRequestsHostState,
): Promise<void> {
  await writeAtomic(paths.state, JSON.stringify(state, null, 2));
}

/** Answers of requests no longer on record (pruned): gone from `out/` too. */
export async function pruneAnswers(paths: SpoolPaths, keep: ReadonlySet<string>): Promise<void> {
  const names = await fsp.readdir(paths.outgoing).catch(() => [] as Array<string>);
  for (const name of names) {
    const id = ID_FILE.exec(name)?.[1];
    if (id !== undefined && !keep.has(id)) {
      await fsp.rm(path.join(paths.outgoing, name), { force: true }).catch(() => undefined);
    }
  }
}

export async function readHostStore(stateDir: string): Promise<HostStore> {
  const text = await fsp.readFile(storePaths(stateDir).store, "utf8").catch(() => null);
  if (text === null) return EMPTY_HOST_STORE;
  try {
    return parseHostStore(JSON.parse(text));
  } catch {
    return EMPTY_HOST_STORE;
  }
}

export async function writeHostStore(stateDir: string, store: HostStore): Promise<void> {
  await writeAtomic(storePaths(stateDir).store, JSON.stringify(store, null, 2));
}

export type JournalEvent =
  | "received"
  | "refused"
  | "expired"
  | "started"
  | "declined"
  | "allowed"
  | "turned-off"
  | "start-failed"
  /** A Start / Decline from Telegram that came too late or found it decided. */
  | "telegram-dropped";

/** One line of the journal of requests and decisions (who asked, what, how it ended). */
export async function appendJournal(
  stateDir: string,
  event: JournalEvent,
  entry: Pick<HostRecord, "id" | "from" | "title" | "gist" | "cwd" | "reason" | "threadId"> | null,
  at: Date = new Date(),
  detail?: string,
): Promise<void> {
  const line = {
    at: at.toISOString(),
    event,
    ...(entry
      ? {
          id: entry.id,
          from: `${entry.from.threadTitle} on ${entry.from.computerName}`,
          fromThreadId: entry.from.threadId,
          title: entry.title,
          gist: entry.gist,
          cwd: entry.cwd,
          ...(entry.reason ? { reason: entry.reason } : {}),
          ...(entry.threadId ? { threadId: entry.threadId } : {}),
        }
      : {}),
    ...(detail ? { detail } : {}),
  };
  const file = storePaths(stateDir).journal;
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fsp.appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}
