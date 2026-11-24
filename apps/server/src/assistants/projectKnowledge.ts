/**
 * The reads behind a project's passport and `project_context`
 * (`projectPassport.ts` holds the wording and the reasons): a fixed set of
 * the project's files and its recent chats from the read model.
 *
 * Read-only and narrow on purpose:
 * - files: AGENTS.md, CLAUDE.md, materials/README.md in the project's folder
 *   and its MEMORY.md (Claude Code's memory of that folder, or one in the
 *   folder) — nothing the assistant names. A file that resolves outside its
 *   folder (a symlink) or to an env / key file is never opened; only its
 *   first bytes are read.
 * - chats: the projection's threads of the project, the last answer of each.
 *
 * Cached: a file is parsed again only when its size or mtime changes, a chat
 * only when it changed (the passport is built on every turn of an assistant).
 *
 * @module assistants/projectKnowledge
 */
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { Effect, Option } from "effect";

import type { ProjectionThread } from "../persistence/Services/ProjectionThreads.ts";
import type { ProjectionThreadMessageRepositoryShape } from "../persistence/Services/ProjectionThreadMessages.ts";
import type { ProjectionThreadRepositoryShape } from "../persistence/Services/ProjectionThreads.ts";
import type { ProjectionThreadSessionRepositoryShape } from "../persistence/Services/ProjectionThreadSessions.ts";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";
import { claudeProjectDirName } from "../sandbox/harnessSandboxExtras.ts";
import {
  fileHead,
  isSecretFileName,
  keyRules,
  onlyPointsAt,
  outcomeLine,
  PROJECT_FILE_HEAD_BYTES,
  PROJECT_MATERIALS_README,
  type ProjectChatOutcome,
  type ProjectChatStatus,
} from "./projectPassport.ts";

/** The project's own instructions, in the order they are shown. */
export const PROJECT_RULE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export interface ProjectFileHead {
  /** The path the file was asked for (relative to its folder). */
  readonly name: string;
  /** The real file (a symlink resolved). */
  readonly realPath: string;
  readonly text: string;
}

const inside = (root: string, path: string) =>
  path === root || path.startsWith(root.endsWith(nodePath.sep) ? root : `${root}${nodePath.sep}`);

/**
 * The first bytes of `<root>/<name>`, or null: missing, not a regular file,
 * outside `root` once symlinks are resolved, an env / key file, unreadable.
 */
export async function readProjectFileHead(
  root: string,
  name: string,
  bytes = PROJECT_FILE_HEAD_BYTES,
): Promise<ProjectFileHead | null> {
  if (isSecretFileName(name)) return null;
  let handle: fsp.FileHandle | undefined;
  try {
    const realRoot = await fsp.realpath(root);
    const realPath = await fsp.realpath(nodePath.join(root, name));
    if (!inside(realRoot, realPath) || isSecretFileName(realPath)) return null;
    const stat = await fsp.stat(realPath);
    if (!stat.isFile()) return null;
    handle = await fsp.open(realPath, "r");
    const buffer = Buffer.alloc(Math.min(bytes, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { name, realPath, text: buffer.subarray(0, bytesRead).toString("utf8") };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** A file's size + mtime, or null: not there. */
async function stampOf(path: string): Promise<string | null> {
  const stat = await fsp.stat(path).catch(() => null);
  return stat?.isFile() ? `${stat.size}:${stat.mtimeMs}` : null;
}

/**
 * The project's AGENTS.md and CLAUDE.md, without a CLAUDE.md that is the
 * same file (a symlink, as in many repos) or only points at AGENTS.md.
 */
export async function readRuleFiles(root: string): Promise<ReadonlyArray<ProjectFileHead>> {
  const files: Array<ProjectFileHead> = [];
  for (const name of PROJECT_RULE_FILES) {
    const file = await readProjectFileHead(root, name);
    if (file === null) continue;
    const same = files.some(
      (known) =>
        known.realPath === file.realPath ||
        known.text === file.text ||
        onlyPointsAt(file.text, known.name),
    );
    if (!same) files.push(file);
  }
  return files;
}

/**
 * The project's memory: Claude Code's MEMORY.md for this folder
 * (`~/.claude/projects/<folder>/memory/`), else a MEMORY.md in the folder.
 */
export async function readProjectMemory(
  root: string,
  home: string,
): Promise<{ readonly path: string; readonly text: string } | null> {
  const memoryDir = nodePath.join(
    home,
    ".claude",
    "projects",
    claudeProjectDirName(root),
    "memory",
  );
  const claude = await readProjectFileHead(memoryDir, "MEMORY.md");
  if (claude !== null) {
    return {
      path: `~/.claude/projects/${claudeProjectDirName(root)}/memory/MEMORY.md`,
      text: claude.text,
    };
  }
  for (const name of ["MEMORY.md", ".claude/MEMORY.md"]) {
    const own = await readProjectFileHead(root, name);
    if (own !== null) return { path: name, text: own.text };
  }
  return null;
}

/** The key rules of a project for its passport; parsed again only when a file changed. */
export function makeRulesReader(): (root: string) => Promise<ReadonlyArray<string>> {
  const parsed = new Map<
    string,
    { readonly stamp: string; readonly rules: ReadonlyArray<string> }
  >();
  return async (root) => {
    const stamps = await Promise.all(
      PROJECT_RULE_FILES.map((name) => stampOf(nodePath.join(root, name))),
    );
    const stamp = stamps.join("|");
    const known = parsed.get(root);
    if (known?.stamp === stamp) return known.rules;
    const files = await readRuleFiles(root);
    const rules = keyRules(files.map((file) => file.text).join("\n\n"));
    parsed.set(root, { stamp, rules });
    return rules;
  };
}

/** What `project_context` shows of the files, each cut to its budget. */
export async function readProjectFilesForContext(
  root: string,
  home: string,
  budgets: { readonly rules: number; readonly materials: number; readonly memory: number },
): Promise<{
  readonly instructions: ReadonlyArray<{ readonly name: string; readonly head: string }>;
  readonly materials: string | null;
  readonly memory: { readonly path: string; readonly head: string } | null;
}> {
  const rules = await readRuleFiles(root);
  const each = rules.length > 0 ? Math.floor(budgets.rules / rules.length) : 0;
  const materials = await readProjectFileHead(root, PROJECT_MATERIALS_README);
  const memory = await readProjectMemory(root, home);
  return {
    instructions: rules.map((file) => ({ name: file.name, head: fileHead(file.text, each) })),
    materials: materials === null ? null : fileHead(materials.text, budgets.materials),
    memory:
      memory === null ? null : { path: memory.path, head: fileHead(memory.text, budgets.memory) },
  };
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

export interface ProjectChatsDeps {
  readonly threads: ProjectionThreadRepositoryShape;
  readonly turns: ProjectionTurnRepositoryShape;
  readonly messages: ProjectionThreadMessageRepositoryShape;
  readonly sessions: ProjectionThreadSessionRepositoryShape;
}

/** A project's chats that count: not deleted, not archived; newest first. */
export const liveChats = (rows: ReadonlyArray<ProjectionThread>): ReadonlyArray<ProjectionThread> =>
  rows
    .filter((thread) => thread.deletedAt === null && thread.archivedAt === null)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));

/**
 * The outcome of one chat, by its read model: its status and the start of
 * its last finished answer. Cached until the chat changes.
 */
export function makeChatOutcomeReader(deps: ProjectChatsDeps) {
  const cache = new Map<string, { readonly key: string; readonly chat: ProjectChatOutcome }>();
  return (thread: ProjectionThread, outcomeChars: number): Effect.Effect<ProjectChatOutcome> => {
    const key = [
      thread.updatedAt,
      thread.latestTurnId ?? "",
      thread.pendingApprovalCount,
      thread.pendingUserInputCount,
      thread.title,
      outcomeChars,
    ].join("|");
    const known = cache.get(thread.threadId);
    if (known?.key === key) return Effect.succeed(known.chat);
    return Effect.gen(function* () {
      const threadId = ThreadId.make(thread.threadId);
      const turn =
        thread.latestTurnId === null
          ? Option.none()
          : yield* deps.turns.getByTurnId({ threadId, turnId: thread.latestTurnId });
      const session = yield* deps.sessions.getByThreadId({ threadId });
      const sessionBusy =
        Option.isSome(session) &&
        (session.value.status === "running" || session.value.status === "starting");
      const turnState = Option.isSome(turn) ? turn.value.state : null;
      const status: ProjectChatStatus =
        thread.pendingApprovalCount > 0 || thread.pendingUserInputCount > 0
          ? "waiting"
          : sessionBusy || turnState === "running" || turnState === "pending"
            ? "running"
            : turnState === "error"
              ? "failed"
              : turnState === "interrupted"
                ? "stopped"
                : turnState === "completed"
                  ? "done"
                  : "new";
      const messageId = Option.isSome(turn) ? turn.value.assistantMessageId : null;
      const message =
        messageId === null ? Option.none() : yield* deps.messages.getByMessageId({ messageId });
      const outcome =
        Option.isSome(message) && !message.value.isStreaming
          ? outcomeLine(message.value.text, outcomeChars)
          : null;
      const chat: ProjectChatOutcome = {
        title: thread.title,
        status,
        at: thread.updatedAt,
        outcome,
      };
      cache.set(thread.threadId, { key, chat });
      return chat;
    }).pipe(
      // A row that can't be read: the chat is still named, without an outcome.
      Effect.orElseSucceed(
        (): ProjectChatOutcome => ({
          title: thread.title,
          status: "new",
          at: thread.updatedAt,
          outcome: null,
        }),
      ),
    );
  };
}
