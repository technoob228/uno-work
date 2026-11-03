/**
 * The backend's live layer of `ComputersLifecycle` (CONTRACT.md §2, §7):
 * provided in server.ts.
 *
 * - purposes: kept at the console (`PATCH …/computers/{id}` `mode`), the local
 *   file as the cache and for consoles from before (§7.1);
 * - `openFolder`: a project here standing for a folder on the computer
 *   (`project.computer`), made once;
 * - `continueInCloud`: the project's files copied here (or the copy brought
 *   before, when the computer is offline), a project in `~/projects` ("On all
 *   my computers"), and a new chat there seeded with the old one's history;
 * - `workScan` / `bringWork`: `bringWork.ts`.
 *
 * @module myComputer/ComputersLifecycleLive
 */
import * as Crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CommandId,
  type ComputersState,
  EventId,
  MessageId,
  MyComputerError,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { ComputersLifecycle, makeComputersLifecycleBase } from "../computers/ComputersLifecycle.ts";
import { lifecycleOverride } from "../computers/purposeStore.ts";
import { ServerConfig } from "../config.ts";
import { systemCommandOrigin } from "../orchestration/commandOrigin.ts";
import { buildContinueSeed } from "../orchestration/handoff.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSyncService } from "../projectSync/ProjectSyncService.ts";
import { createBringWork, folderName } from "./bringWork.ts";
import { planOf, sharedPurposeStore } from "./ComputerWorkspaces.ts";
import { ChatImportService } from "./import/ChatImportService.ts";
import { safeSegment } from "./import/chatHistory.ts";
import { MyComputerFailure } from "./myComputerCore.ts";
import { MyComputerService } from "./MyComputerService.ts";
import { copyFolderFromComputer } from "./projectCopy.ts";

const ORIGIN = systemCommandOrigin("computers-lifecycle");

const asError = (cause: unknown) =>
  new MyComputerError({
    message: (cause instanceof Error ? cause.message : String(cause)).trim() || "It didn't work.",
  });

const hash = (...parts: ReadonlyArray<string>) =>
  Crypto.createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);

const commandId = (what: string) => CommandId.make(`computers:${what}:${Crypto.randomUUID()}`);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const myComputer = yield* MyComputerService;
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const chatImport = yield* ChatImportService;
  const projectSync = Option.getOrNull(yield* Effect.serviceOption(ProjectSyncService));
  const core = myComputer.core;
  const store = sharedPurposeStore(config.stateDir);
  const home = os.homedir();

  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    run(engine.dispatch(command, { origin: ORIGIN }));

  // A wait mark lives only as long as the turn that set it: after a restart of
  // the daemon no turn is waiting, so a mark still on a chat is left over
  // (CONTRACT §7.6). Cleared once at start, in the background.
  yield* projections.getShellSnapshot().pipe(
    Effect.flatMap((shell) =>
      Effect.forEach(
        shell.threads.filter((thread) => thread.computerWait != null),
        (thread) =>
          engine
            .dispatch(
              {
                type: "thread.computer-wait.set",
                commandId: commandId("wait-cleared"),
                threadId: thread.id,
                computerWait: null,
                createdAt: new Date().toISOString(),
              },
              { origin: ORIGIN },
            )
            .pipe(Effect.ignore),
        { discard: true },
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("computers lifecycle: couldn't clear leftover waits", cause),
    ),
    Effect.forkDetach,
  );

  const base = makeComputersLifecycleBase({
    store,
    status: myComputer.status,
    override: lifecycleOverride(process.env.UNO_WORK_COMPUTERS_LIFECYCLE),
  });

  /** The console's purposes over the local ones (the console wins). */
  const withConsolePurposes = (state: ComputersState): ComputersState => {
    const meta = core.meta();
    if (meta === null) return state;
    const merged = new Map(state.purposes.map((entry) => [entry.computerId, entry.purpose]));
    for (const [computerId, entry] of meta.computers) {
      if (entry.mode !== null) merged.set(computerId, entry.mode);
    }
    return {
      ...state,
      purposes: [...merged.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([computerId, purpose]) => ({ computerId, purpose })),
    };
  };

  /** A Work project for a folder here (found by its folder, else made). */
  const projectForFolder = async (folder: string, title: string): Promise<string> => {
    const existing = await run(
      projections
        .getActiveProjectByWorkspaceRoot(folder)
        .pipe(Effect.orElseSucceed(() => Option.none())),
    );
    if (Option.isSome(existing)) return existing.value.id;
    const projectId = ProjectId.make(`brought-${hash(folder, String(Date.now()))}`);
    await dispatch({
      type: "project.create",
      commandId: commandId("project"),
      projectId,
      title,
      workspaceRoot: folder,
      createWorkspaceRootIfMissing: true,
      createdAt: new Date().toISOString(),
    });
    return projectId;
  };

  const bring = createBringWork({
    stateDir: config.stateDir,
    home,
    core,
    chatFolders: async (computerId) => {
      try {
        const file = path.join(
          config.stateDir,
          "my-computer",
          safeSegment(computerId),
          "import.json",
        );
        const record = JSON.parse(await fsp.readFile(file, "utf8")) as {
          projects?: Record<string, unknown>;
        };
        return Object.keys(record.projects ?? {}).filter((dir) => dir.length > 0);
      } catch {
        return [];
      }
    },
    projectFor: projectForFolder,
    syncOn: async (projectId) => {
      if (projectSync === null) return;
      await run(projectSync.setEnabled(projectId, true));
    },
    setKey: async (projectId, name, value) => {
      if (projectSync === null) throw new Error("Keys can't be kept on this computer.");
      await run(projectSync.secretSet(projectId, name, value));
    },
    warn: (message) => {
      Effect.runFork(Effect.logWarning(message));
    },
  });

  const computerNamed = async (computerId: string) => {
    const status = await core.status();
    const computer = status.computers.find((entry) => entry.id === computerId);
    if (!status.enabled || computer === undefined) {
      throw new MyComputerFailure("remote", "This computer isn't connected any more.");
    }
    return computer;
  };

  const openFolder = async (input: { readonly computerId: string; readonly path: string }) => {
    const computer = await computerNamed(input.computerId);
    const name = computer.name || "My computer";
    let folder = input.path.trim();
    if (folder === "~" || folder.startsWith("~/")) {
      // The helper knows the computer's home folder; offline keeps `~` (it expands it).
      const info = computer.online ? await core.info(input.computerId).catch(() => null) : null;
      const remoteHome = typeof info?.["home"] === "string" ? (info["home"] as string) : null;
      if (remoteHome) folder = folder === "~" ? remoteHome : `${remoteHome}/${folder.slice(2)}`;
    }
    folder = folder.length > 1 ? folder.replace(/[\\/]+$/, "") : folder;
    const shell = await run(projections.getShellSnapshot());
    const existing = shell.projects.find(
      (project) =>
        project.computer?.computerId === input.computerId && project.computer.path === folder,
    );
    const title = input.path.trim() === "~" ? "Home folder" : folderName(folder);
    if (existing) {
      return {
        projectId: existing.id,
        workspaceRoot: existing.workspaceRoot,
        title: existing.title,
      };
    }
    const projectId = ProjectId.make(`computer-${hash(input.computerId, folder)}`);
    // A real, empty folder here: what `cd`s into a project's root keeps working.
    const workspaceRoot = path.join(
      config.baseDir,
      "computers",
      safeSegment(input.computerId),
      projectId,
    );
    await fsp.mkdir(workspaceRoot, { recursive: true });
    await dispatch({
      type: "project.create",
      commandId: commandId("open-folder"),
      projectId,
      title,
      workspaceRoot,
      createWorkspaceRootIfMissing: true,
      computer: { computerId: input.computerId, computerName: name, path: folder },
      createdAt: new Date().toISOString(),
    });
    return { projectId, workspaceRoot, title };
  };

  const continueInCloud = async (threadId: string) => {
    const shell = Option.getOrNull(
      await run(projections.getThreadShellById(ThreadId.make(threadId))),
    );
    if (shell === null) throw new MyComputerFailure("remote", "This chat isn't here any more.");
    const project = Option.getOrNull(
      await run(projections.getProjectShellById(ProjectId.make(shell.projectId))),
    );
    const plan = planOf(shell, project);
    if (plan === null && shell.source == null) {
      return { threadId: shell.id };
    }
    const computerId = plan?.computerId ?? shell.source!.computerId;
    const computerName = plan?.computerName ?? shell.source!.computerName;
    const status = await core.cachedStatus(5_000).catch(() => null);
    const online = status?.computers.find((entry) => entry.id === computerId)?.online === true;

    // The files: copied now when the computer is there, else the copy brought before.
    let folder: string | null = null;
    if (plan !== null) {
      const brought = await bring.broughtFolder(computerId, plan.path);
      if (online) {
        const target = brought ?? (await bring.freeFolder(folderName(plan.path)));
        // The home folder never comes over (keys, private files): the chat
        // continues in an empty project with its history.
        const copied = await copyFolderFromComputer({
          core,
          computerId,
          source: plan.path,
          destination: target,
          threadId,
        }).then(
          () => true,
          (cause: unknown) => {
            if (cause instanceof MyComputerFailure && cause.kind === "home-folder") return false;
            throw cause;
          },
        );
        if (copied) {
          folder = target;
          await bring.rememberFolder(computerId, plan.path, folder);
        }
      } else if (brought !== null) {
        folder = brought;
      } else {
        throw new MyComputerFailure(
          "remote",
          `${computerName} is offline and this project's files aren't in the cloud yet. Open ${computerName} and try again.`,
        );
      }
    }
    // An imported chat without a folder: an empty project of its own here.
    folder ??= await bring.freeFolder(shell.title.slice(0, 40) || "chat");
    const projectId = await projectForFolder(folder, plan ? folderName(plan.path) : shell.title);
    if (projectSync !== null) {
      await run(projectSync.setEnabled(projectId, true).pipe(Effect.ignore));
    }

    // The conversation so far: from the computer's file for an imported chat.
    let messages: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }> =
      [];
    if (shell.source != null) {
      const history = await run(
        chatImport.history(threadId).pipe(Effect.orElseSucceed(() => null)),
      );
      if (history?.kind === "ready") messages = history.messages;
    } else {
      const detail = Option.getOrNull(
        await run(
          projections
            .getThreadDetailById(ThreadId.make(threadId))
            .pipe(Effect.orElseSucceed(() => Option.none())),
        ),
      );
      messages = (detail?.messages ?? []).flatMap((message) =>
        message.role === "user" || message.role === "assistant"
          ? [{ role: message.role, text: message.text }]
          : [],
      );
    }
    const seedText = buildContinueSeed({
      thread: {
        title: shell.title,
        messages: messages.map((message) => ({ ...message, streaming: false })),
      },
      sourceMachineLabel: computerName,
      sourceBranch: null,
    });
    const newThreadId = ThreadId.make(Crypto.randomUUID());
    const createdAt = new Date().toISOString();
    await dispatch({
      type: "thread.create",
      commandId: commandId("thread"),
      threadId: newThreadId,
      projectId: ProjectId.make(projectId),
      title: shell.title,
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      branch: null,
      worktreePath: null,
      createdAt,
    });
    await dispatch({
      type: "thread.message.user.append",
      commandId: commandId("seed"),
      threadId: newThreadId,
      messageId: MessageId.make(Crypto.randomUUID()),
      text: seedText,
      createdAt,
    });
    await dispatch({
      type: "thread.activity.append",
      commandId: commandId("continued-from"),
      threadId: newThreadId,
      activity: {
        id: EventId.make(Crypto.randomUUID()),
        tone: "info",
        kind: "thread.continued.from",
        summary: `Continued from ${computerName}`,
        payload: {
          sourceMachineLabel: computerName,
          sourceThreadId: threadId,
          worktreePath: folder,
        },
        turnId: null,
        createdAt,
      },
      createdAt,
    });
    return { threadId: newThreadId };
  };

  const attempt = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: asError });

  return ComputersLifecycle.of({
    state: base.state.pipe(Effect.map(withConsolePurposes)),
    setPurpose: (computerId, purpose) =>
      Effect.gen(function* () {
        // The console first: every cloud computer of the account sees it.
        yield* attempt(() => core.setMode(computerId, purpose)).pipe(
          Effect.catch((error) =>
            // A console from before keeps no purposes: the local choice still holds.
            /HTTP 40[45]|isn't available/i.test(error.message) ? Effect.void : Effect.fail(error),
          ),
        );
        const state = yield* base.setPurpose(computerId, purpose);
        // Fresh console word for the next routing decision.
        yield* attempt(() => core.status()).pipe(Effect.ignore);
        return withConsolePurposes(state);
      }),
    purposeOf: (computerId) =>
      Effect.sync(
        () => core.meta()?.computers.get(computerId)?.mode ?? store.purposeOf(computerId),
      ),
    forget: base.forget,
    workStatus: (computerId) => attempt(() => bring.status(computerId)),
    workScan: (computerId) => attempt(() => bring.scan(computerId)),
    bringWork: (input) => attempt(() => bring.bring(input.computerId, input.projects)),
    openFolder: (input) =>
      attempt(() => openFolder(input)).pipe(
        Effect.map((result) => ({ ...result, projectId: ProjectId.make(result.projectId) })),
      ),
    continueInCloud: (input) => attempt(() => continueInCloud(input.threadId)),
  });
});

/** The live layer (server.ts). */
export const ComputersLifecycleLive = Layer.effect(ComputersLifecycle, make);
