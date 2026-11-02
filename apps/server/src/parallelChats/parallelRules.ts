/**
 * Pure rules of parallel chats (spec sections 2 and 10): where a chat's copy
 * lives and who owns it, which projects and chats take part, and what a turn
 * start does.
 *
 * A copy made by Uno ("auto-copy") is recognised by its path alone:
 * `<worktreesDir>/<folder name>/uno-auto-<first 8 of the thread id>`, with
 * `branch: null`. No new thread fields, no migrations.
 *
 * @module parallelChats/parallelRules
 */
import nodePath from "node:path";

import type { ParallelChatsMode } from "@t3tools/contracts";
import { isNoProjectRoot } from "@t3tools/shared/noProject";

export const AUTO_COPY_PREFIX = "uno-auto-";
/** A project gets no more live copies than this; the next chat works in the folder. */
export const MAX_LIVE_COPIES = 3;
/** A folder with more files than this gets no copies (its snapshot would hold up the turn). */
export const MAX_PROJECT_FILES = 100_000;
/** Making a copy takes longer than this: the chat works in the folder, as before. */
export const COPY_TIMEOUT_MS = 20_000;
/** A turn that never showed as running stops holding the folder after this. */
export const STARTING_TURN_TTL_MS = 3 * 60_000;
export const APPLY_ATTEMPTS = 3;
export const APPLY_RETRY_DELAY_MS = 2_000;
export const PARALLEL_CHATS_ENV = "UNO_WORK_PARALLEL_CHATS";

/** The setting, unless the environment says otherwise (machines and tests). */
export function effectiveParallelMode(
  setting: ParallelChatsMode | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ParallelChatsMode {
  const override = env[PARALLEL_CHATS_ENV]?.trim().toLowerCase();
  if (override === "off" || override === "nogit" || override === "all") return override;
  return setting ?? "off";
}

export function autoCopyName(threadId: string): string {
  return `${AUTO_COPY_PREFIX}${threadId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}`;
}

export function autoCopyPath(input: {
  readonly worktreesDir: string;
  readonly root: string;
  readonly threadId: string;
}): string {
  const folder = nodePath.basename(nodePath.resolve(input.root)) || "project";
  return nodePath.join(nodePath.resolve(input.worktreesDir), folder, autoCopyName(input.threadId));
}

/** A copy Uno made for some chat (any chat). */
export function isAutoCopyPath(worktreesDir: string, path: string | null | undefined): boolean {
  if (!path) return false;
  const resolved = nodePath.resolve(path);
  return (
    nodePath.dirname(nodePath.dirname(resolved)) === nodePath.resolve(worktreesDir) &&
    nodePath.basename(resolved).startsWith(AUTO_COPY_PREFIX)
  );
}

/** This chat's own auto-copy (not one it inherited from the chat it was opened from). */
export function isOwnAutoCopy(
  worktreesDir: string,
  path: string | null | undefined,
  threadId: string,
): boolean {
  return (
    isAutoCopyPath(worktreesDir, path) &&
    nodePath.basename(nodePath.resolve(path!)) === autoCopyName(threadId)
  );
}

export type IneligibleReason =
  | "off"
  | "home"
  | "no-project"
  | "assistant"
  | "own-git"
  | "no-sync"
  | "own-folder";

/** Whether a project can give its chats copies at all. */
export function projectIneligibleReason(input: {
  readonly mode: ParallelChatsMode;
  readonly root: string;
  readonly home: string;
  readonly isAssistantProject: boolean;
  readonly repoKind: "own-git" | "uno-git" | "none";
}): IneligibleReason | null {
  if (input.mode === "off") return "off";
  const root = nodePath.resolve(input.root);
  if (root === nodePath.resolve(input.home)) return "home";
  if (isNoProjectRoot(root, input.home)) return "no-project";
  if (input.isAssistantProject) return "assistant";
  // Projects with their own git: not touched at all (coordinator, 02.11).
  if (input.repoKind === "own-git") return "own-git";
  if (input.repoKind === "none") return "no-sync";
  return null;
}

export type CopyRefusal =
  | "low-disk"
  | "too-many-copies"
  | "too-many-files"
  | "cannot-move-session"
  | "copy-failed";

/** The limits checked before a copy is made. */
export function copyLimitRefusal(input: {
  readonly lowDisk: boolean;
  readonly liveCopies: number;
  readonly fileCount: number | null;
}): CopyRefusal | null {
  if (input.lowDisk) return "low-disk";
  if (input.liveCopies >= MAX_LIVE_COPIES) return "too-many-copies";
  if (input.fileCount !== null && input.fileCount > MAX_PROJECT_FILES) return "too-many-files";
  return null;
}

/**
 * A chat that already has a session in the folder can move to a copy only if
 * its agent picks the session up there. Claude: yes, with its transcript
 * copied to the copy's project folder (spec section 5). Codex, OpenCode, Uno
 * Code, Hermes, Cursor and custom agents: not yet, they stay in the folder.
 * A chat with no session to resume moves on any agent.
 */
export function sessionMove(input: {
  readonly hasResumableSession: boolean;
  readonly driver: string | null;
}): "fresh" | "claude-transcript" | "cannot" {
  if (!input.hasResumableSession) return "fresh";
  return input.driver === "claudeAgent" ? "claude-transcript" : "cannot";
}

/** Claude Code's project folder name for a cwd: everything but `[A-Za-z0-9]` becomes `-`. */
export function claudeProjectDirName(cwd: string): string {
  return nodePath.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

/** Session statuses during which a chat is working. */
export function sessionIsBusy(status: string | null | undefined): boolean {
  return status === "running" || status === "starting";
}

/**
 * A turn start Uno made busy before its session showed it: the status
 * becomes "running" with a delay, so two starts in a row would both find the
 * folder free. Cleared when the status says running, or the turn failed.
 */
export function startingTurnClearedBy(status: string): boolean {
  return (
    status === "running" || status === "error" || status === "stopped" || status === "interrupted"
  );
}

/** A finished turn whose work may join the folder ("error" waits: auto-retry may go on). */
export function sessionEndsTurn(status: string): boolean {
  return status === "ready" || status === "interrupted";
}

/** `name (from Chat title).ext`: the chat's version of a binary file, next to the project's. */
export function keptVersionName(path: string, chatTitle: string): string {
  const dir = nodePath.posix.dirname(path);
  const base = nodePath.posix.basename(path);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  const title =
    chatTitle
      .split("")
      .map((char) => (char.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(char) ? " " : char))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40)
      .trim() || "another chat";
  const name = `${stem} (from ${title})${ext}`;
  return dir === "." ? name : `${dir}/${name}`;
}

/** What a conflict ref records (its commit message). */
export interface ConflictRecord {
  readonly kind: "text" | "other";
  readonly files: ReadonlyArray<string>;
  readonly otherTitle: string;
  /** When the copy started waiting: a turn requested after it may settle it. */
  readonly parkedAt: string;
}

export function encodeConflictRecord(record: ConflictRecord): string {
  return `Uno: waiting to combine\n\n${JSON.stringify(record)}\n`;
}

export function decodeConflictRecord(message: string): ConflictRecord | null {
  const start = message.indexOf("{");
  if (start === -1) return null;
  try {
    const raw = JSON.parse(message.slice(start)) as Partial<ConflictRecord>;
    if (raw.kind !== "text" && raw.kind !== "other") return null;
    if (!Array.isArray(raw.files)) return null;
    return {
      kind: raw.kind,
      files: raw.files.filter((file): file is string => typeof file === "string"),
      otherTitle: typeof raw.otherTitle === "string" ? raw.otherTitle : "another chat",
      parkedAt: typeof raw.parkedAt === "string" ? raw.parkedAt : "",
    };
  } catch {
    return null;
  }
}

/** Added to the agent's note while files wait for the person's choice (no markers to edit). */
export function parkedOtherAgentNote(input: {
  readonly files: ReadonlyArray<string>;
  readonly root: string;
}): string {
  return [
    `Another chat changed these files in the project folder (${input.root}) in a way that can't be combined with your copy: ${input.files.join(", ")}.`,
    "The person decides which version to keep. Make this copy hold the version to keep",
    "(copy it from the project folder if they want the other chat's version); it then joins the project.",
  ].join("\n");
}
