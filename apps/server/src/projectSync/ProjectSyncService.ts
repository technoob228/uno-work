/**
 * ProjectSyncService — "On all my computers" in the daemon: the core
 * (`projectSyncCore.ts`) wired to this computer — the engine from the App
 * SDK on disk, the Uno vault with this computer's key, the projects of the
 * orchestration read model, and agents' turns (a turn's end syncs its
 * edits out; a turn's start brings the other computers' changes in).
 *
 * @module projectSync/ProjectSyncService
 */
import os from "node:os";
import path from "node:path";
import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  CommandId,
  ProjectId,
  ProjectSyncError,
  type ProjectSecretsList,
  type ProjectSyncEntry,
  type ProjectSyncFiles,
  type ProjectSyncGetHereResult,
  type ProjectSyncHistory,
  type ProjectSyncSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option, Stream } from "effect";

import { installSdkFiles } from "../appSdk/sdkFiles.ts";
import { ServerConfig } from "../config.ts";
import { systemCommandOrigin } from "../orchestration/commandOrigin.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { UnoCloudService } from "../workspaceRegistry/UnoCloudService.ts";
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";
import { watchProjectFolder } from "./folderWatch.ts";
import {
  createProjectSyncCore,
  personName,
  type ProjectSyncCore,
  type SyncEngine,
} from "./projectSyncCore.ts";
import { consoleProjectVault } from "./vaultProjectSecrets.ts";

export interface ProjectSyncShape {
  readonly status: Effect.Effect<ProjectSyncSnapshot, ProjectSyncError>;
  readonly setEnabled: (
    projectId: string,
    enabled: boolean,
  ) => Effect.Effect<ProjectSyncEntry, ProjectSyncError>;
  readonly syncNow: (projectId: string) => Effect.Effect<ProjectSyncEntry, ProjectSyncError>;
  readonly resolve: (
    projectId: string,
    keep: "mine" | "theirs" | "dismiss",
  ) => Effect.Effect<ProjectSyncEntry, ProjectSyncError>;
  readonly getHere: (name: string) => Effect.Effect<ProjectSyncGetHereResult, ProjectSyncError>;
  readonly opened: (projectId: string) => Effect.Effect<void>;
  readonly history: (
    projectId: string,
    skip?: number,
  ) => Effect.Effect<ProjectSyncHistory, ProjectSyncError>;
  readonly restore: (
    projectId: string,
    version: string,
    files?: ReadonlyArray<string>,
  ) => Effect.Effect<ProjectSyncEntry, ProjectSyncError>;
  readonly files: (projectId: string) => Effect.Effect<ProjectSyncFiles, ProjectSyncError>;
  readonly setLocalOnly: (
    projectId: string,
    path: string,
    localOnly: boolean,
  ) => Effect.Effect<ProjectSyncFiles, ProjectSyncError>;
  readonly introSeen: Effect.Effect<void, ProjectSyncError>;
  readonly answerOld: (turnOn: boolean) => Effect.Effect<void, ProjectSyncError>;
  readonly secretsList: (projectId: string) => Effect.Effect<ProjectSecretsList, ProjectSyncError>;
  readonly secretSet: (
    projectId: string,
    name: string,
    value: string,
  ) => Effect.Effect<ProjectSecretsList, ProjectSyncError>;
  readonly secretRemove: (
    projectId: string,
    name: string,
  ) => Effect.Effect<ProjectSecretsList, ProjectSyncError>;
  /** `request_secret` wrote a key into a folder's `.env` (best-effort, never fails). */
  readonly secretWritten: (input: {
    cwd: string;
    file: string;
    name: string;
    value: string;
  }) => Effect.Effect<void>;
  /** For agents' `project_keys`: the project of a folder, its key names, re-reading the vault. */
  readonly keysForFolder: (
    cwd: string,
  ) => Effect.Effect<ProjectSecretsList | null, ProjectSyncError>;
  readonly loadKeysForFolder: (cwd: string) => Effect.Effect<ProjectSecretsList, ProjectSyncError>;
}

export class ProjectSyncService extends Context.Service<ProjectSyncService, ProjectSyncShape>()(
  "t3/projectSync/ProjectSyncService",
) {}

const failure = (error: unknown) =>
  new ProjectSyncError({
    message:
      (error instanceof Error ? error.message : String(error)).trim() || "Project sync failed.",
  });

/** The account/computer key in settings that reaches the person's Uno cloud (not an Uno AI key). */
export function cloudKeyOf(uno: {
  readonly boxToken?: string | undefined;
  readonly apiKey: string;
}): string | null {
  const box = uno.boxToken?.trim() ?? "";
  if (box) return box;
  const key = uno.apiKey.trim();
  return key && !key.startsWith("unollm_") ? key : null;
}

/** The engine the daemon wrote to `~/.uno/sdk/js/` (it runs next to the git helper it starts). */
async function loadEngine(home: string): Promise<SyncEngine> {
  const file = path.join(home, ".uno", "sdk", "js", "uno-sync.mjs");
  if (!(await stat(file).catch(() => null))) await installSdkFiles(home);
  return (await import(pathToFileURL(file).href)) as SyncEngine;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const projections = yield* ProjectionSnapshotQuery;
  const orchestration = yield* OrchestrationEngineService;
  const cloud = yield* Effect.serviceOption(UnoCloudService);
  const home = os.homedir();
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  const cloudKey = () =>
    run(
      settings.getSettings.pipe(
        Effect.map((current) => cloudKeyOf(current.uno)),
        Effect.orElseSucceed(() => null),
      ),
    );

  let engine: Promise<SyncEngine> | null = null;
  const core: ProjectSyncCore = createProjectSyncCore({
    home,
    stateDir: config.stateDir,
    hostname: os.hostname(),
    env: process.env,
    engine: () =>
      (engine ??= loadEngine(home).catch((error) => {
        engine = null;
        throw error;
      })),
    available: async () => (await cloudKey()) !== null,
    person: () =>
      Option.isSome(cloud)
        ? run(
            cloud.value.getState().pipe(
              Effect.map((state) => (state.account ? personName(state.account) : null)),
              Effect.orElseSucceed(() => null),
            ),
          )
        : Promise.resolve(null),
    turnRunning: (projectId) =>
      run(
        projections.getShellSnapshot().pipe(
          Effect.map((snapshot) =>
            snapshot.threads.some(
              (thread) =>
                thread.projectId === projectId &&
                // A chat in its own copy of the project isn't touching this folder.
                thread.worktreePath === null &&
                thread.session?.status === "running",
            ),
          ),
          Effect.orElseSucceed(() => false),
        ),
      ),
    vault: consoleProjectVault({ baseUrl: controlPlaneBaseUrl(), token: cloudKey }),
    projects: () =>
      run(
        projections.getShellSnapshot().pipe(
          Effect.map((snapshot) =>
            snapshot.projects.map((project) => ({
              id: project.id,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              createdAt: project.createdAt,
            })),
          ),
          Effect.orElseSucceed(() => []),
        ),
      ),
    createProject: (input) =>
      run(
        Effect.gen(function* () {
          const existing = yield* projections
            .getActiveProjectByWorkspaceRoot(input.workspaceRoot)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(existing)) return existing.value.id as string;
          const projectId = ProjectId.make(crypto.randomUUID());
          yield* orchestration.dispatch(
            {
              type: "project.create",
              commandId: CommandId.make(crypto.randomUUID()),
              projectId,
              title: input.title,
              workspaceRoot: input.workspaceRoot,
              createdAt: new Date().toISOString(),
            },
            { origin: systemCommandOrigin("project-sync", "get-it-here") },
          );
          return projectId as string;
        }),
      ),
    timers: {
      setTimeout: (callback, ms) => {
        const timer = setTimeout(callback, ms);
        timer.unref?.();
        return timer;
      },
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now(),
    },
    watch: (dir, onChange) => watchProjectFolder(dir, onChange),
    log: (level, message, data) =>
      void Effect.runFork(
        level === "warn" ? Effect.logWarning(message, data) : Effect.logInfo(message, data),
      ),
  });

  yield* Effect.acquireRelease(
    Effect.promise(() => core.start().catch(() => undefined)),
    () => Effect.sync(() => core.stop()),
  );

  // Agents' turns: the end sends their edits out; the start brings the other computers' changes in.
  // A new project starts syncing by itself.
  yield* Effect.forkScoped(
    Stream.runForEach(orchestration.streamDomainEvents, (event) => {
      if (event.type === "project.created") {
        return Effect.sync(() => {
          void core.adoptNewProjects().catch(() => undefined);
        });
      }
      const trigger =
        event.type === "thread.turn-diff-completed"
          ? ("turn-end" as const)
          : event.type === "thread.turn-start-requested"
            ? ("turn-start" as const)
            : null;
      if (trigger === null) return Effect.void;
      const threadId = (event.payload as { threadId?: string }).threadId;
      if (!threadId) return Effect.void;
      return projections.getThreadShellById(ThreadId.make(threadId)).pipe(
        Effect.map((thread) => {
          if (Option.isSome(thread)) core.touched(thread.value.projectId, trigger);
        }),
        Effect.orElseSucceed(() => undefined),
      );
    }),
  );

  const attempt = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: failure });

  const keysForFolder = (cwd: string) =>
    attempt(async () => {
      const projectId = await core.projectForFolder(cwd);
      return projectId ? core.secretsList(projectId) : null;
    });

  return {
    status: attempt(() => core.status()),
    setEnabled: (projectId, enabled) => attempt(() => core.setEnabled(projectId, enabled)),
    syncNow: (projectId) => attempt(() => core.syncNow(projectId)),
    resolve: (projectId, keep) => attempt(() => core.resolve(projectId, keep)),
    getHere: (name) =>
      attempt(async () => {
        const result = await core.getHere(name);
        return { projectId: ProjectId.make(result.projectId), entry: result.entry };
      }),
    opened: (projectId) => Effect.sync(() => core.touched(projectId, "opened")),
    history: (projectId, skip) => attempt(() => core.history(projectId, skip)),
    restore: (projectId, version, files) => attempt(() => core.restore(projectId, version, files)),
    files: (projectId) => attempt(() => core.files(projectId)),
    setLocalOnly: (projectId, relative, localOnly) =>
      attempt(() => core.setLocalOnly(projectId, relative, localOnly)),
    introSeen: attempt(() => core.introSeen()),
    answerOld: (turnOn) => attempt(() => core.answerOld(turnOn)),
    secretsList: (projectId) => attempt(() => core.secretsList(projectId)),
    secretSet: (projectId, name, value) =>
      attempt(async () => {
        await core.secretSet(projectId, name, value);
        return core.secretsList(projectId);
      }),
    secretRemove: (projectId, name) =>
      attempt(async () => {
        await core.secretRemove(projectId, name);
        return core.secretsList(projectId);
      }),
    secretWritten: (input) =>
      Effect.promise(() => core.secretWritten(input).catch(() => undefined)),
    keysForFolder,
    loadKeysForFolder: (cwd) =>
      attempt(async () => {
        const projectId = await core.projectForFolder(cwd);
        if (!projectId) throw new Error("This chat's folder isn't a project in Uno Work.");
        await core.loadKeys(projectId);
        return core.secretsList(projectId);
      }),
  } satisfies ProjectSyncShape;
});

export const ProjectSyncServiceLive = Layer.effect(ProjectSyncService, make);
