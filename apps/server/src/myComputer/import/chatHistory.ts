/**
 * A chat's history, read from the computer when the person opens it and kept on
 * this computer as a plain file, so it opens again without the tunnel. Only
 * what the person said and the assistant's text; tool output stays behind.
 * Never logged.
 *
 * @module myComputer/import/chatHistory
 */
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import type { ThreadComputerSource } from "@t3tools/contracts";

import { isChatSessionPath, isZstdPath } from "./chatPaths.ts";
import { parseClaudeHistory } from "./claudeSessions.ts";
import { canReadZstd, decompressZstd, openCodeRunner, type ComputerProbe } from "./chatScan.ts";
import { parseCodexHistory } from "./codexSessions.ts";
import type { ComputerAccess } from "./computerAccess.ts";
import { openCodeFingerprint, readOpenCodeHistory } from "./openCodeSessions.ts";
import type { HistoryMessage } from "./sessionText.ts";

/** A longer session is read from the end: the start of a marathon can wait. */
const HISTORY_MAX_FILE_BYTES = 24 * 1024 * 1024;
const HISTORY_MAX_MESSAGES = 1000;
/** One pasted log shouldn't weigh more than the rest of the chat. */
const MESSAGE_MAX_CHARS = 20_000;
const HISTORY_MAX_TOTAL_CHARS = 4 * 1024 * 1024;

export interface LoadedHistory {
  readonly messages: ReadonlyArray<HistoryMessage>;
  /** Older messages exist on the computer but aren't here. */
  readonly truncated: boolean;
}

export interface CachedHistory extends LoadedHistory {
  readonly fingerprint: string;
}

/** The most a chat shows here: the newest messages, each of a sane size. */
export function trimHistory(loaded: LoadedHistory): LoadedHistory {
  const recent = loaded.messages.slice(-HISTORY_MAX_MESSAGES);
  const kept: Array<HistoryMessage> = [];
  let chars = 0;
  for (const message of recent.toReversed()) {
    const text =
      message.text.length <= MESSAGE_MAX_CHARS
        ? message.text
        : `${message.text.slice(0, MESSAGE_MAX_CHARS)}\n\n[message cut, it is longer on your computer]`;
    chars += text.length;
    if (chars > HISTORY_MAX_TOTAL_CHARS) break;
    kept.push(text === message.text ? message : { ...message, text });
  }
  return {
    messages: kept.toReversed(),
    truncated: loaded.truncated || kept.length < loaded.messages.length,
  };
}

/** What makes the cached copy current; null when the chat is gone from the computer. */
export async function chatFingerprint(
  access: ComputerAccess,
  probe: ComputerProbe,
  source: ThreadComputerSource,
): Promise<string | null> {
  if (source.tool === "opencode") {
    const run = openCodeRunner(access, probe, source.path);
    if (run === null) throw new Error("This computer can't read OpenCode's chats any more.");
    return openCodeFingerprint(run, source.sessionId);
  }
  if (!isChatSessionPath(source.path)) return null;
  const stat = await access.stat(source.path);
  // A symlink put in a session's place is not that session.
  if (!stat.exists || stat.kind !== "file") return null;
  return `${stat.size}:${stat.mtime ?? ""}`;
}

async function readWholeOrEnd(
  access: ComputerAccess,
  path: string,
): Promise<{ readonly data: Buffer; readonly cut: boolean }> {
  const stat = await access.stat(path);
  const offset = Math.max(0, stat.size - HISTORY_MAX_FILE_BYTES);
  const answer = await access.read({ path, offset, maxBytes: HISTORY_MAX_FILE_BYTES });
  return { data: answer.data, cut: offset > 0 };
}

export async function loadChatHistory(
  access: ComputerAccess,
  probe: ComputerProbe,
  source: ThreadComputerSource,
): Promise<LoadedHistory> {
  if (source.tool === "opencode") {
    const run = openCodeRunner(access, probe, source.path);
    if (run === null) throw new Error("This computer can't read OpenCode's chats any more.");
    return trimHistory(await readOpenCodeHistory(run, source.sessionId));
  }
  const { data, cut } = await readWholeOrEnd(access, source.path);
  let text: string;
  if (isZstdPath(source.path)) {
    // The end of a compressed file means nothing on its own.
    if (cut || !canReadZstd()) throw new Error("This chat is too long to open here.");
    text = (await decompressZstd(data)).toString("utf8");
  } else {
    text = data.toString("utf8");
  }
  const messages = source.tool === "claude" ? parseClaudeHistory(text) : parseCodexHistory(text);
  return trimHistory({ messages, truncated: cut });
}

export function historyCachePath(stateDir: string, computerId: string, key: string): string {
  return Path.join(stateDir, "my-computer", safeSegment(computerId), "history", `${key}.json`);
}

export const safeSegment = (value: string) => value.replace(/[^\w.-]/g, "_");

export async function readHistoryCache(path: string): Promise<CachedHistory | null> {
  try {
    const parsed = JSON.parse(await Fs.readFile(path, "utf8")) as CachedHistory;
    return Array.isArray(parsed.messages) && typeof parsed.fingerprint === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomic, so a chat opened twice at once never reads half a file. */
export async function writeJsonPrivately(path: string, value: unknown): Promise<void> {
  await Fs.mkdir(Path.dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await Fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await Fs.rename(temporary, path);
}
