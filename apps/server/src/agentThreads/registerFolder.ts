/**
 * A folder of this computer becomes a project when a chat is started in it
 * (`chat_create` with `cwd`) and it is not one yet.
 *
 * The person keeps projects in ~/projects without adding each to Uno Work;
 * Uno handed "read the backlog in luckyip" to nobody because luckyip was no
 * project (Misha 29.10). Only a real folder inside the home folder counts —
 * never a hidden one (~/.ssh) or an assistant's own folder.
 *
 * @module agentThreads/registerFolder
 */
import {
  CommandId,
  type ModelSelection,
  type OrchestrationProjectShell,
  ProjectId,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";

import { systemCommandOrigin } from "../orchestration/commandOrigin.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { normalizeWorkspacePath } from "./logic.ts";

export const REGISTER_FOLDER_ORIGIN_COMPONENT = "folder-project";

/** Marker of an assistant's workspace (AssistantService). */
const ASSISTANT_MARKER = ".uno-assistant.json";

/**
 * Whether `folder` (absolute, normalized) may become a project: the home
 * folder itself or below it, no hidden segment on the way.
 */
export function isRegistrableFolder(folder: string, home: string): boolean {
  const root = normalizeWorkspacePath(home);
  const target = normalizeWorkspacePath(folder);
  if (!nodePath.isAbsolute(target)) return false;
  if (target === root) return true;
  const relative = nodePath.relative(root, target);
  if (relative.length === 0 || relative.startsWith("..") || nodePath.isAbsolute(relative)) {
    return false;
  }
  return relative
    .split(nodePath.sep)
    .every((segment) => segment.length > 0 && !segment.startsWith("."));
}

/** The project's title: the folder's name ("Home folder" for the home folder). */
export function folderProjectTitle(folder: string, home: string): string {
  const target = normalizeWorkspacePath(folder);
  return target === normalizeWorkspacePath(home) ? "Home folder" : nodePath.basename(target);
}

async function isPlainDirectory(folder: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(folder);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  try {
    await fsp.access(nodePath.join(folder, ASSISTANT_MARKER));
    return false;
  } catch {
    return true;
  }
}

export interface RegisterFolderDeps {
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly projections: Pick<
    ProjectionSnapshotQueryShape,
    "getActiveProjectByWorkspaceRoot" | "getProjectShellById"
  >;
  /** The AI a new project starts with (the computer's usable default); null: none ready. */
  readonly defaultModelSelection: Effect.Effect<ModelSelection | null>;
  readonly home: string;
  readonly nowMs?: () => number;
}

/** {@link AgentThreadsDeps.registerFolder}: the folder's project, made now, or null. */
export const makeRegisterFolder =
  (deps: RegisterFolderDeps) =>
  (cwd: string): Effect.Effect<OrchestrationProjectShell | null> =>
    Effect.gen(function* () {
      const folder = normalizeWorkspacePath(cwd);
      if (!isRegistrableFolder(folder, deps.home)) return null;
      if (!(yield* Effect.promise(() => isPlainDirectory(folder)))) return null;
      // Someone else may have made it a moment ago.
      const existing = yield* deps.projections.getActiveProjectByWorkspaceRoot(folder);
      if (Option.isSome(existing)) {
        const shell = yield* deps.projections.getProjectShellById(existing.value.id);
        return Option.getOrNull(shell);
      }
      const selection = yield* deps.defaultModelSelection;
      if (selection === null) return null;
      const projectId = ProjectId.make(crypto.randomUUID());
      yield* deps.engine.dispatch(
        {
          type: "project.create",
          commandId: CommandId.make(`folder-project:${crypto.randomUUID()}`),
          projectId,
          title: folderProjectTitle(folder, deps.home),
          workspaceRoot: folder,
          defaultModelSelection: selection,
          createdAt: new Date((deps.nowMs ?? Date.now)()).toISOString(),
        },
        {
          origin: systemCommandOrigin(REGISTER_FOLDER_ORIGIN_COMPONENT, "chat started in a folder"),
        },
      );
      for (let tries = 0; tries < 50; tries += 1) {
        const shell = yield* deps.projections.getProjectShellById(projectId);
        if (Option.isSome(shell)) return shell.value;
        yield* Effect.sleep("100 millis");
      }
      return null;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("folder project registration failed").pipe(
          Effect.annotateLogs({ cwd, cause: String(cause) }),
          Effect.as(null),
        ),
      ),
    );
