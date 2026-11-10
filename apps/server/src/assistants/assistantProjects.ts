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

import { isAssistantProjectId } from "@t3tools/contracts";
import { Context, Effect, Layer } from "effect";

import { ServerConfig } from "../config.ts";
import { ManagerCapabilityTokenRepositoryLive } from "../persistence/Layers/ManagerCapabilityTokens.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ManagerCapabilityTokenRepository } from "../persistence/Services/ManagerCapabilityTokens.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { readAssistantAccess } from "./assistantAccess.ts";
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
}

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
      const fresh = head === null ? null : projectBrief(head, title);
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
    const home = os.homedir();
    const readFiles = makeProjectFilesReader();
    // What each assistant was last told: a read that fails mid-session must
    // not look like "your projects are gone" on the next turn.
    const lastRead = new Map<string, string | null>();

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
        const rows = (yield* projects.listAll()).filter(
          (project) =>
            project.deletedAt === null &&
            !isAssistantProjectId(project.projectId) &&
            (allowed === null || allowed.has(project.projectId)),
        );
        if (rows.length === 0) return null;
        const briefFrom = Math.max(0, rows.length - ASSISTANT_PROJECTS_WITH_BRIEF);
        const entries = yield* Effect.forEach(
          rows,
          (project, index): Effect.Effect<AssistantProjectEntry> => {
            const computer = project.computer ?? null;
            // A folder on the person's own computer: its files aren't here.
            if (computer !== null) {
              return Effect.succeed({
                title: project.title,
                folder: computer.path,
                brief: null,
                instructions: [],
                computerName: computer.computerName,
              });
            }
            const folder = homeRelativeFolder(project.workspaceRoot, home);
            if (index < briefFrom) {
              return Effect.succeed({
                title: project.title,
                folder,
                brief: null,
                instructions: [],
              });
            }
            return Effect.promise(() => readFiles(project.workspaceRoot, project.title)).pipe(
              Effect.map((files) => ({ title: project.title, folder, ...files })),
            );
          },
          { concurrency: 4 },
        );
        return assistantProjectsBlock({
          projects: entries,
          scope: allowed === null ? "all" : "selected",
        });
      }).pipe(
        Effect.tap((block) => Effect.sync(() => lastRead.set(assistantProjectId, block))),
        Effect.catchCause((cause) =>
          Effect.logWarning("assistant projects: could not read them for its context", {
            assistantProjectId,
            cause,
          }).pipe(Effect.as(lastRead.get(assistantProjectId) ?? null)),
        ),
      );

    return { blockFor } satisfies AssistantProjectsShape;
  }),
).pipe(
  Layer.provide(ProjectionProjectRepositoryLive),
  Layer.provide(ManagerCapabilityTokenRepositoryLive),
);
