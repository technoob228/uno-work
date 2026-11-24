/**
 * The projects an assistant manages on this computer, read for its session's
 * system prompt (`projectsHint.ts` holds the wording and the reason): the
 * person's projects within its access, each with its folder and one line
 * from the project's own AGENTS.md / CLAUDE.md / README.md.
 *
 * A service of its own, under the provider drivers: the Hermes driver builds
 * the assistant's context when a session starts and on every turn, and the
 * read model with the projects lives above it (orchestration). This reads
 * the two tables it needs itself — projects and the assistant's token.
 *
 * @module assistants/assistantProjects
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { isAssistantProjectId, ProjectId, type ManagerProjectAllowlist } from "@t3tools/contracts";
import { Context, Effect, Layer } from "effect";

import { ServerConfig } from "../config.ts";
import { ManagerCapabilityTokenRepositoryLive } from "../persistence/Layers/ManagerCapabilityTokens.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { ProjectionThreadSessionRepositoryLive } from "../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ManagerCapabilityTokenRepository } from "../persistence/Services/ManagerCapabilityTokens.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { ProjectionThreadSessionRepository } from "../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { readAssistantAccess } from "./assistantAccess.ts";
import {
  liveChats,
  makeChatOutcomeReader,
  makeRulesReader,
  readProjectFilesForContext,
} from "./projectKnowledge.ts";
import {
  matchProjectRef,
  PASSPORT_ACTIVE_DAYS,
  PASSPORT_CHATS,
  PASSPORT_OUTCOME_CHARS,
  PASSPORT_PROJECTS_MAX,
  passportsBlock,
  redactProjectText,
  PROJECT_CONTEXT_CHATS_DEFAULT,
  PROJECT_CONTEXT_CHATS_MAX,
  PROJECT_CONTEXT_MEMORY_CHARS,
  PROJECT_CONTEXT_OUTCOME_CHARS,
  PROJECT_CONTEXT_README_CHARS,
  PROJECT_CONTEXT_RULES_CHARS,
  projectContextText,
  type ProjectPassport,
} from "./projectPassport.ts";
import {
  ASSISTANT_PROJECTS_WITH_BRIEF,
  assistantProjectsBlock,
  homeRelativeFolder,
  PROJECT_INSTRUCTION_FILES,
  PROJECT_INSTRUCTIONS_HEAD_BYTES,
  projectBrief,
  type AssistantProjectEntry,
} from "./projectsHint.ts";

export interface AssistantProjectsShape {
  /**
   * The "Your projects" block of an assistant (by its project id), or null:
   * it has none. Never fails: an unreadable table or file reads as "nothing
   * to say" — the assistant still works, as it did before the block.
   */
  readonly blockFor: (assistantProjectId: string) => Effect.Effect<string | null>;
  /**
   * `project_context`: one project's rules, materials, memory and last
   * chats, as text fenced as the project's data — or why there is none (no
   * such project within `allowlist`, several match). Read-only; never fails.
   */
  readonly contextFor: (input: {
    readonly allowlist: ManagerProjectAllowlist;
    /** Its title, folder (`~/projects/site`) or id. */
    readonly project: string;
    readonly chats?: number | undefined;
  }) => Effect.Effect<ProjectContextResult>;
}

export type ProjectContextResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

export class AssistantProjects extends Context.Service<AssistantProjects, AssistantProjectsShape>()(
  "t3/assistants/AssistantProjects",
) {}

/** The first bytes of a file, or null: not there, not a file, unreadable. */
async function readHead(path: string, bytes: number): Promise<string | null> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(path, "r");
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

interface ProjectFiles {
  readonly brief: string | null;
  readonly instructions: ReadonlyArray<string>;
}

/**
 * What a project's own files say about it. Read on every turn of an
 * assistant, so a file is parsed again only when it changed (size + mtime).
 */
export function makeProjectFilesReader(): (root: string, title: string) => Promise<ProjectFiles> {
  const parsed = new Map<string, { readonly stamp: string; readonly brief: string | null }>();
  return async (root, title) => {
    const instructions: Array<string> = [];
    let brief: string | null = null;
    for (const name of PROJECT_INSTRUCTION_FILES) {
      const path = nodePath.join(root, name);
      const stat = await fsp.stat(path).catch(() => null);
      if (stat === null || !stat.isFile()) {
        parsed.delete(path);
        continue;
      }
      // README.md describes a project but instructs nobody.
      if (name !== "README.md") instructions.push(name);
      if (brief !== null) continue;
      const stamp = `${stat.size}:${stat.mtimeMs}:${title}`;
      const known = parsed.get(path);
      if (known?.stamp === stamp) {
        brief = known.brief;
        continue;
      }
      const head = await readHead(path, PROJECT_INSTRUCTIONS_HEAD_BYTES);
      // The line goes into a model's prompt: a key pasted into the file is masked.
      const fresh = head === null ? null : projectBrief(redactProjectText(head), title);
      parsed.set(path, { stamp, brief: fresh });
      brief = fresh;
    }
    return { brief, instructions };
  };
}

export const AssistantProjectsLive = Layer.effect(
  AssistantProjects,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const projects = yield* ProjectionProjectRepository;
    const tokens = yield* ManagerCapabilityTokenRepository;
    const threads = yield* ProjectionThreadRepository;
    const chatOutcome = makeChatOutcomeReader({
      threads,
      turns: yield* ProjectionTurnRepository,
      messages: yield* ProjectionThreadMessageRepository,
      sessions: yield* ProjectionThreadSessionRepository,
    });
    const home = os.homedir();
    const readFiles = makeProjectFilesReader();
    const readRules = makeRulesReader();
    // What each assistant was last told: a read that fails mid-session must
    // not look like "your projects are gone" on the next turn.
    const lastRead = new Map<string, string | null>();

    /** The person's projects within an allowlist (null: all), in creation order. */
    const projectsWithin = (allowed: ReadonlySet<string> | null) =>
      projects
        .listAll()
        .pipe(
          Effect.map((rows) =>
            rows.filter(
              (project) =>
                project.deletedAt === null &&
                !isAssistantProjectId(project.projectId) &&
                (allowed === null || allowed.has(project.projectId)),
            ),
          ),
        );

    const chatsOf = (project: ProjectionProject) =>
      threads
        .listByProjectId({ projectId: ProjectId.make(project.projectId) })
        .pipe(Effect.map(liveChats));

    /**
     * Passports of the most recently active projects on this computer
     * (a chat within PASSPORT_ACTIVE_DAYS), newest first.
     */
    const passportsOf = (
      rows: ReadonlyArray<ProjectionProject>,
      briefs: Map<string, string | null>,
    ) =>
      Effect.gen(function* () {
        const since = new Date(Date.now() - PASSPORT_ACTIVE_DAYS * 86_400_000).toISOString();
        const local = rows.filter((project) => (project.computer ?? null) === null);
        const active = yield* Effect.forEach(
          local,
          (project) =>
            chatsOf(project).pipe(
              Effect.map((chats) => ({ project, chats })),
              Effect.orElseSucceed(() => ({ project, chats: [] as ReadonlyArray<never> })),
            ),
          { concurrency: 4 },
        );
        const ranked = active
          .filter(({ chats }) => chats.length > 0 && chats[0]!.updatedAt >= since)
          .toSorted((left, right) =>
            right.chats[0]!.updatedAt.localeCompare(left.chats[0]!.updatedAt),
          )
          .slice(0, PASSPORT_PROJECTS_MAX);
        return yield* Effect.forEach(
          ranked,
          ({ project, chats }) =>
            Effect.gen(function* () {
              const rules = yield* Effect.promise(() => readRules(project.workspaceRoot));
              const recent = yield* Effect.forEach(
                chats.slice(0, PASSPORT_CHATS),
                (thread) => chatOutcome(thread, PASSPORT_OUTCOME_CHARS),
                { concurrency: 3 },
              );
              return {
                projectId: project.projectId,
                passport: {
                  title: project.title,
                  folder: homeRelativeFolder(project.workspaceRoot, home),
                  essence: briefs.get(project.projectId) ?? null,
                  rules,
                  chats: recent,
                } satisfies ProjectPassport,
              };
            }),
          { concurrency: 2 },
        );
      });

    const blockFor: AssistantProjectsShape["blockFor"] = (assistantProjectId) =>
      Effect.gen(function* () {
        // An assistant whose token isn't issued yet gets what a new token
        // gets: every project (the same reading as the sandbox policy).
        const access = yield* readAssistantAccess(
          { tokens, stateDir: config.stateDir, unsetAllowlist: "all" },
          assistantProjectId,
        );
        const allowed =
          access.allowlist === "all"
            ? null
            : new Set<string>(access.allowlist as ReadonlyArray<string>);
        const rows = yield* projectsWithin(allowed);
        if (rows.length === 0) return null;
        const briefFrom = Math.max(0, rows.length - ASSISTANT_PROJECTS_WITH_BRIEF);
        // The essence of every project with files here (a passport may go to
        // an older one: the list gives a line only to the newest).
        const briefs = new Map<string, string | null>();
        const files = yield* Effect.forEach(
          rows,
          (project) =>
            (project.computer ?? null) !== null
              ? Effect.succeed(null)
              : Effect.promise(() => readFiles(project.workspaceRoot, project.title)).pipe(
                  Effect.tap((read) =>
                    Effect.sync(() => briefs.set(project.projectId, read.brief)),
                  ),
                ),
          { concurrency: 4 },
        );
        const passports = yield* passportsOf(rows, briefs);
        const withPassport = new Set(passports.map((entry) => entry.projectId));
        const entries = rows.map((project, index): AssistantProjectEntry => {
          const computer = project.computer ?? null;
          // A folder on the person's own computer: its files aren't here.
          if (computer !== null) {
            return {
              title: project.title,
              folder: computer.path,
              brief: null,
              instructions: [],
              computerName: computer.computerName,
            };
          }
          const folder = homeRelativeFolder(project.workspaceRoot, home);
          const read = files[index] ?? null;
          if (withPassport.has(project.projectId)) {
            return {
              title: project.title,
              folder,
              brief: null,
              instructions: read?.instructions ?? [],
              passport: true,
            };
          }
          if (index < briefFrom || read === null) {
            return { title: project.title, folder, brief: null, instructions: [] };
          }
          return { title: project.title, folder, ...read };
        });
        const list = assistantProjectsBlock({
          projects: entries,
          scope: allowed === null ? "all" : "selected",
        });
        const block = passportsBlock(passports.map((entry) => entry.passport));
        return list === null ? null : block === null ? list : `${list}\n\n${block}`;
      }).pipe(
        Effect.tap((block) => Effect.sync(() => lastRead.set(assistantProjectId, block))),
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant projects: could not read them for its context", {
            assistantProjectId,
            cause,
          }).pipe(Effect.as(lastRead.get(assistantProjectId) ?? null)),
        ),
      );

    const contextFor: AssistantProjectsShape["contextFor"] = (input) =>
      Effect.gen(function* () {
        const allowed =
          input.allowlist === "all"
            ? null
            : new Set<string>(input.allowlist as ReadonlyArray<string>);
        const rows = yield* projectsWithin(allowed);
        const candidates = rows.map((project) => ({
          projectId: project.projectId,
          title: project.title,
          folder: project.computer?.path ?? homeRelativeFolder(project.workspaceRoot, home),
          root: project.computer?.path ?? project.workspaceRoot,
          row: project,
        }));
        const named = (list: ReadonlyArray<{ title: string; folder: string }>) =>
          list
            .slice(0, 30)
            .map((project) => `${project.title} (${project.folder})`)
            .join(", ");
        const match = matchProjectRef(input.project, candidates);
        if (match.kind === "none") {
          return {
            ok: false as const,
            error:
              candidates.length === 0
                ? "You have no projects on this computer."
                : `No project of yours matches "${input.project.slice(0, 80)}". Yours: ${named(candidates)}.`,
          };
        }
        if (match.kind === "many") {
          return {
            ok: false as const,
            error: `Several projects match "${input.project.slice(0, 80)}": ${named(match.candidates)}. Call again with the folder.`,
          };
        }
        const { row, folder } = match.project;
        const wanted = Math.min(
          PROJECT_CONTEXT_CHATS_MAX,
          Math.max(1, Math.floor(input.chats ?? PROJECT_CONTEXT_CHATS_DEFAULT)),
        );
        const chats = yield* chatsOf(row).pipe(Effect.orElseSucceed(() => []));
        const recent = yield* Effect.forEach(
          chats.slice(0, wanted),
          (thread) => chatOutcome(thread, PROJECT_CONTEXT_OUTCOME_CHARS),
          { concurrency: 3 },
        );
        const computer = row.computer ?? null;
        const files =
          computer !== null
            ? { instructions: [], materials: null, memory: null }
            : yield* Effect.promise(() =>
                readProjectFilesForContext(row.workspaceRoot, home, {
                  rules: PROJECT_CONTEXT_RULES_CHARS,
                  materials: PROJECT_CONTEXT_README_CHARS,
                  memory: PROJECT_CONTEXT_MEMORY_CHARS,
                }),
              );
        return {
          ok: true as const,
          text: projectContextText({
            title: row.title,
            folder,
            ...(computer !== null ? { computerName: computer.computerName } : {}),
            ...files,
            chats: recent,
            totalChats: chats.length,
          }),
        };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant projects: project_context could not read", { cause }).pipe(
            Effect.as({
              ok: false as const,
              error: "Could not read the project just now; try once more.",
            }),
          ),
        ),
      );

    return { blockFor, contextFor } satisfies AssistantProjectsShape;
  }),
).pipe(
  Layer.provide(ProjectionProjectRepositoryLive),
  Layer.provide(ManagerCapabilityTokenRepositoryLive),
  Layer.provide(ProjectionThreadRepositoryLive),
  Layer.provide(ProjectionTurnRepositoryLive),
  Layer.provide(ProjectionThreadMessageRepositoryLive),
  Layer.provide(ProjectionThreadSessionRepositoryLive),
);
