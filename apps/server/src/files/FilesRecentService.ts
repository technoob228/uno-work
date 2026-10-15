/**
 * FilesRecentService — Files → Recent on this computer.
 *
 * - `record`: a file the person opened in Uno Work (Files, the right panel,
 *   a pin). Kept in the daemon's state dir (`files-recent.json`, 0600), at
 *   most 200, newest first — so the list is the same on every device.
 * - `list`: those, plus the files agents changed in chats (the turns'
 *   checkpoint summaries in `projection_turns`), one row per file, newest
 *   first. Each one is stat'ed: only files that still exist inside the files
 *   root come back; agents' changes to hidden files (dotfiles) are left out.
 *
 * Pure logic lives in `recentFiles.ts`.
 *
 * @module files/FilesRecentService
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import nodePath from "node:path";

import type {
  FilesEntry,
  FilesError,
  FilesRecentItem,
  FilesRecentListInput,
  FilesRecentListResult,
  FilesRecentRecordInput,
  FilesRecentRecordResult,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Context, Effect, Layer, Ref } from "effect";

import { ServerConfig } from "../config.ts";
import { FilesService } from "./FilesService.ts";
import { isHiddenPath } from "./filesPaths.ts";
import {
  addRecentOpened,
  agentChangesFromTurns,
  mergeRecentFiles,
  parseRecentOpened,
  type RecentOpened,
  type RecentTurnRow,
} from "./recentFiles.ts";

const DEFAULT_LIST_LIMIT = 60;
/** Turns read for agents' changes (the newest ones that changed anything). */
const AGENT_TURNS_SCANNED = 300;
/** Candidates stat'ed per list: a few more than asked, as some are gone. */
const CANDIDATE_SLACK = 40;
const STAT_CONCURRENCY = 16;

export interface FilesRecentServiceShape {
  readonly list: (input: FilesRecentListInput) => Effect.Effect<FilesRecentListResult, FilesError>;
  readonly record: (
    input: FilesRecentRecordInput,
  ) => Effect.Effect<FilesRecentRecordResult, FilesError>;
}

export class FilesRecentService extends Context.Service<
  FilesRecentService,
  FilesRecentServiceShape
>()("t3/files/FilesRecentService") {}

async function readOpened(filePath: string): Promise<RecentOpened[]> {
  try {
    return parseRecentOpened(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return [];
  }
}

async function writeOpened(filePath: string, items: ReadonlyArray<RecentOpened>) {
  await mkdir(nodePath.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify({ version: 1, items }), { mode: 0o600 });
  await rename(temp, filePath);
}

export const makeFilesRecentService = (options: { readonly filePath?: string } = {}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const files = yield* FilesService;
    const sql = yield* SqlClient.SqlClient;
    const filePath = options.filePath ?? nodePath.join(config.stateDir, "files-recent.json");

    const openedRef = yield* Ref.make<ReadonlyArray<RecentOpened>>(
      yield* Effect.promise(() => readOpened(filePath)),
    );
    // One write at a time, in order; a failed write is retried by the next open.
    let writing: Promise<void> = Promise.resolve();
    const persist = (items: ReadonlyArray<RecentOpened>) =>
      Effect.sync(() => {
        writing = writing.then(() => writeOpened(filePath, items)).catch(() => undefined);
      });
    yield* Effect.addFinalizer(() => Effect.promise(() => writing));

    const statOrNull = (path: string) =>
      files.stat({ path }).pipe(Effect.orElseSucceed((): FilesEntry | null => null));

    const record: FilesRecentServiceShape["record"] = (input) =>
      Effect.gen(function* () {
        const entry = yield* statOrNull(input.path);
        if (entry === null || entry.kind !== "file") return { recorded: false };
        const next = yield* Ref.updateAndGet(openedRef, (items) =>
          addRecentOpened(items, entry.path, new Date().toISOString()),
        );
        yield* persist(next);
        return { recorded: true };
      });

    const agentTurns = sql<RecentTurnRow>`
      SELECT
        turns.thread_id AS "threadId",
        threads.title AS "threadTitle",
        threads.worktree_path AS "worktreePath",
        projects.workspace_root AS "workspaceRoot",
        turns.completed_at AS "completedAt",
        turns.checkpoint_files_json AS "filesJson"
      FROM projection_turns AS turns
      JOIN projection_threads AS threads ON threads.thread_id = turns.thread_id
      JOIN projection_projects AS projects ON projects.project_id = threads.project_id
      WHERE turns.completed_at IS NOT NULL
        AND turns.checkpoint_files_json <> '[]'
        AND threads.deleted_at IS NULL
        AND projects.deleted_at IS NULL
      ORDER BY turns.completed_at DESC
      LIMIT ${AGENT_TURNS_SCANNED}
    `.pipe(
      // Recent stays useful without the chats' part: what was opened still shows.
      Effect.orElseSucceed((): ReadonlyArray<RecentTurnRow> => []),
    );

    const list: FilesRecentServiceShape["list"] = (input) =>
      Effect.gen(function* () {
        const limit = input.limit ?? DEFAULT_LIST_LIMIT;
        const root = yield* files.rootPath;
        const opened = yield* Ref.get(openedRef);
        const changes = agentChangesFromTurns(yield* agentTurns);
        const candidates = mergeRecentFiles(opened, changes, limit + CANDIDATE_SLACK);
        const entries = yield* Effect.forEach(
          candidates,
          (candidate) => statOrNull(candidate.path),
          {
            concurrency: STAT_CONCURRENCY,
          },
        );
        const items: FilesRecentItem[] = [];
        const seen = new Set<string>();
        candidates.forEach((candidate, index) => {
          const entry = entries[index];
          if (!entry || entry.kind !== "file" || seen.has(entry.path)) return;
          if (candidate.source === "agent" && isHiddenPath(root, entry.path)) return;
          seen.add(entry.path);
          items.push({
            entry,
            source: candidate.source,
            at: candidate.at,
            threadId: candidate.source === "agent" ? candidate.threadId : null,
            threadTitle: candidate.source === "agent" ? candidate.threadTitle : null,
          });
        });
        return { items: items.slice(0, limit) };
      });

    return { list, record } satisfies FilesRecentServiceShape;
  });

export const FilesRecentServiceLive = Layer.effect(FilesRecentService, makeFilesRecentService());
