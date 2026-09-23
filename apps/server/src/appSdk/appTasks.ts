/**
 * `POST /v1/tasks` — an app gives the machine's AI a job.
 *
 * A task is an ordinary Work chat: a thread in the project of the task's
 * folder, titled `[App name] …`, started with the app's prompt. The person
 * sees it in the sidebar, can watch it, answer its approvals and stop it —
 * the transparency is the point. Every command carries the origin
 * `{kind: "app", appId}`, so the event store records which app did it.
 *
 * Trust boundary:
 * - the app is who its token says, never the body;
 * - the folder is resolved (symlinks too) and must stay inside home;
 * - how much the agent may do alone is the narrower of what the app asks and
 *   what the person allowed the app (Settings → Apps, default "edit");
 * - an app only ever sees its own tasks (the caller looks them up in its own
 *   ledger before any read here).
 */
import {
  type AppTaskTools,
  CommandId,
  type ModelSelection,
  MessageId,
  narrowAppTaskTools,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";
import * as crypto from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  defaultTitleFromText,
  deriveAgentThreadStatus,
  resolveProviderModelSelection,
} from "../agentThreads/logic.ts";
import { resolveInsideHome } from "../machineApps/appManifest.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { selectAutoBootstrapModelSelection } from "../provider/autoBootstrapModelSelection.ts";
import type { StoredAppTask } from "./appAiStore.ts";

export const APP_TASK_PROMPT_MAX_CHARS = 20_000;
export const APP_TASK_RESULT_MAX_CHARS = 100_000;

export type AppTaskStatus = "running" | "waiting" | "done" | "error" | "stopped";

export interface AppTaskView {
  readonly id: string;
  readonly threadId: string;
  readonly status: AppTaskStatus;
  readonly tools: AppTaskTools;
  readonly harness: string;
  readonly createdAt: string;
  readonly result: { readonly text: string } | null;
  readonly changedFiles: ReadonlyArray<string>;
  readonly waitingFor: "approval" | "input" | null;
  readonly error: string | null;
}

export interface AppTaskCaller {
  readonly appId: string;
  readonly appName: string;
  /** The manifest's `cwd` (already inside home), used when the task names none. */
  readonly manifestCwd: string | null;
  readonly taskToolsCap: AppTaskTools;
}

export interface AppTasksDeps {
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly projections: Pick<
    ProjectionSnapshotQueryShape,
    | "getThreadShellById"
    | "getThreadDetailById"
    | "getActiveProjectByWorkspaceRoot"
    | "getFirstActiveThreadIdByProjectId"
  >;
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  /** Settings → Apps → "AI for apps" (null = the machine's default harness). */
  readonly getTaskModelSelection: Effect.Effect<ModelSelection | null>;
  readonly home: string;
}

export interface AppApiReply {
  readonly status: number;
  readonly body: unknown;
}

export const apiError = (status: number, code: string, message: string): AppApiReply => ({
  status,
  body: { error: { type: code, code, message } },
});

const TOOL_MODES: Record<
  AppTaskTools,
  { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode }
> = {
  read: { runtimeMode: "approval-required", interactionMode: "plan" },
  ask: { runtimeMode: "approval-required", interactionMode: "default" },
  edit: { runtimeMode: "auto-accept-edits", interactionMode: "default" },
  full: { runtimeMode: "full-access", interactionMode: "default" },
};

export function modesForTools(tools: AppTaskTools) {
  return TOOL_MODES[tools];
}

function parseTools(value: unknown): AppTaskTools | null | undefined {
  if (value === undefined || value === null) return undefined;
  return value === "read" || value === "ask" || value === "edit" || value === "full" ? value : null;
}

/** Resolves `cwd` (`~/x`, relative to home, or absolute) and proves it stays inside home. */
export async function resolveTaskCwd(
  raw: unknown,
  fallback: string,
  home: string,
): Promise<{ ok: true; cwd: string } | { ok: false; code: string; message: string }> {
  const lexical = raw === undefined || raw === null ? fallback : resolveInsideHome(raw, home);
  if (lexical === null) {
    return { ok: false, code: "cwd_outside_home", message: "cwd must be inside the home folder." };
  }
  let real: string;
  let realHome: string;
  try {
    [real, realHome] = await Promise.all([realpath(lexical), realpath(home)]);
  } catch {
    return {
      ok: false,
      code: "cwd_not_found",
      message: `The folder ${lexical} does not exist. Create it first.`,
    };
  }
  const relative = path.relative(realHome, real);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      ok: false,
      code: "cwd_outside_home",
      message: "cwd leads outside the home folder (through a link).",
    };
  }
  const info = await stat(real).catch(() => null);
  if (!info?.isDirectory()) {
    return { ok: false, code: "cwd_not_found", message: `${lexical} is not a folder.` };
  }
  return { ok: true, cwd: real };
}

export function taskStatusFromShell(
  shell: Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "session" | "latestTurn" | "latestUserMessageAt"
  >,
): { status: AppTaskStatus; waitingFor: "approval" | "input" | null } {
  const derived = deriveAgentThreadStatus(shell);
  if (derived === "waiting") {
    return { status: "waiting", waitingFor: shell.hasPendingApprovals ? "approval" : "input" };
  }
  if (derived === "running") return { status: "running", waitingFor: null };
  if (derived === "error") return { status: "error", waitingFor: null };
  return {
    status: shell.latestTurn?.state === "interrupted" ? "stopped" : "done",
    waitingFor: null,
  };
}

export function lastAssistantAnswer(detail: Pick<OrchestrationThread, "messages">): string | null {
  for (let index = detail.messages.length - 1; index >= 0; index -= 1) {
    const message = detail.messages[index];
    if (message?.role === "user") return null;
    if (message?.role === "assistant" && message.text.trim().length > 0) {
      return message.text.slice(0, APP_TASK_RESULT_MAX_CHARS);
    }
  }
  return null;
}

export function changedFilesOf(
  detail: Pick<OrchestrationThread, "checkpoints">,
  fromTurnCount: number,
): string[] {
  const files = new Set<string>();
  for (const checkpoint of detail.checkpoints) {
    if (checkpoint.checkpointTurnCount <= fromTurnCount) continue;
    for (const file of checkpoint.files) files.add(file.path);
  }
  return [...files].toSorted();
}

export function makeAppTasks(deps: AppTasksDeps) {
  const commandId = (tag: string) => CommandId.make(`app:${tag}:${crypto.randomUUID()}`);

  const dispatch = (command: OrchestrationCommand, caller: AppTaskCaller, taskId: string) =>
    deps.engine.dispatch(command, { origin: { kind: "app", appId: caller.appId, taskId } });

  const resolveModelSelection = (harness: string | undefined, model: string | undefined) =>
    Effect.gen(function* () {
      const providers = yield* deps.getProviders;
      if (harness !== undefined && harness !== "default") {
        const resolved = resolveProviderModelSelection({ provider: harness, model, providers });
        return resolved.ok
          ? ({ ok: true, selection: resolved.selection } as const)
          : ({ ok: false, message: resolved.message } as const);
      }
      const chosen = yield* deps.getTaskModelSelection;
      const selection = chosen ?? selectAutoBootstrapModelSelection(providers);
      if (selection === null) {
        return {
          ok: false,
          message:
            "No AI agent is ready on this computer. Sign in to Uno or install an agent in Settings → Agents.",
        } as const;
      }
      return {
        ok: true,
        selection: model !== undefined ? { ...selection, model } : selection,
      } as const;
    });

  /** Finds the project of the folder or creates one, so the chat lives next to its files. */
  const projectFor = (
    cwd: string,
    selection: ModelSelection,
    caller: AppTaskCaller,
    taskId: string,
  ) =>
    Effect.gen(function* () {
      const existing = yield* deps.projections
        .getActiveProjectByWorkspaceRoot(cwd)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(existing)) return existing.value.id;
      const projectId = ProjectId.make(crypto.randomUUID());
      yield* dispatch(
        {
          type: "project.create",
          commandId: commandId("project"),
          projectId,
          title: path.basename(cwd) || "Home",
          workspaceRoot: cwd,
          defaultModelSelection: selection,
          createdAt: new Date().toISOString(),
        },
        caller,
        taskId,
      );
      return projectId;
    });

  /** Returns the reply and, on success, what to remember in the app's ledger. */
  const createTask = (
    caller: AppTaskCaller,
    rawBody: unknown,
  ): Effect.Effect<{ reply: AppApiReply; task: StoredAppTask | null }> =>
    Effect.gen(function* () {
      const fail = (status: number, code: string, message: string) => ({
        reply: apiError(status, code, message),
        task: null,
      });
      const body =
        typeof rawBody === "object" && rawBody !== null && !Array.isArray(rawBody)
          ? (rawBody as Record<string, unknown>)
          : null;
      const prompt = typeof body?.["prompt"] === "string" ? body["prompt"].trim() : "";
      if (prompt.length === 0) {
        return fail(
          400,
          "invalid_request",
          'Expected JSON {"prompt": string, "cwd"?, "title"?, "harness"?, "model"?, "tools"?}.',
        );
      }
      if (prompt.length > APP_TASK_PROMPT_MAX_CHARS) {
        return fail(
          400,
          "invalid_request",
          `prompt is longer than ${APP_TASK_PROMPT_MAX_CHARS} characters.`,
        );
      }
      const requestedTools = parseTools(body?.["tools"]);
      if (requestedTools === null) {
        return fail(400, "invalid_request", 'tools must be "read", "ask", "edit" or "full".');
      }
      const tools = narrowAppTaskTools(requestedTools ?? "ask", caller.taskToolsCap);
      const harness = typeof body?.["harness"] === "string" ? body["harness"].trim() : undefined;
      const model =
        typeof body?.["model"] === "string" && body["model"].trim().length > 0
          ? body["model"].trim()
          : undefined;
      const title =
        typeof body?.["title"] === "string" && body["title"].trim().length > 0
          ? body["title"].trim().slice(0, 80)
          : defaultTitleFromText(prompt);

      const cwd = yield* Effect.promise(() =>
        resolveTaskCwd(body?.["cwd"], caller.manifestCwd ?? deps.home, deps.home),
      );
      if (!cwd.ok) return fail(400, cwd.code, cwd.message);

      const selection = yield* resolveModelSelection(harness, model);
      if (!selection.ok) return fail(400, "harness_unavailable", selection.message);

      const taskId = `task_${crypto.randomUUID().replaceAll("-", "")}`;
      const threadId = ThreadId.make(crypto.randomUUID());
      const modes = modesForTools(tools);
      const createdAt = new Date().toISOString();
      const outcome = yield* Effect.gen(function* () {
        const projectId = yield* projectFor(cwd.cwd, selection.selection, caller, taskId);
        yield* dispatch(
          {
            type: "thread.create",
            commandId: commandId("create"),
            threadId,
            projectId,
            title: `[${caller.appName}] ${title}`,
            modelSelection: selection.selection,
            runtimeMode: modes.runtimeMode,
            interactionMode: modes.interactionMode,
            branch: null,
            worktreePath: null,
            createdAt,
          },
          caller,
          taskId,
        );
        yield* dispatch(
          {
            type: "thread.turn.start",
            commandId: commandId("turn"),
            threadId,
            message: {
              messageId: MessageId.make(crypto.randomUUID()),
              role: "user",
              text: prompt,
              attachments: [],
            },
            runtimeMode: modes.runtimeMode,
            interactionMode: modes.interactionMode,
            createdAt,
          },
          caller,
          taskId,
        );
        return { ok: true as const };
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("app sdk: task dispatch failed", { appId: caller.appId, error }).pipe(
            Effect.as({ ok: false as const }),
          ),
        ),
      );
      if (!outcome.ok) {
        return fail(500, "task_not_started", "Work could not start the task. Try again.");
      }
      yield* Effect.logInfo("app sdk: task started", {
        appId: caller.appId,
        taskId,
        threadId,
        tools,
        instanceId: selection.selection.instanceId,
      });
      const task: StoredAppTask = {
        id: taskId,
        threadId,
        createdAt,
        tools,
        harness: selection.selection.instanceId,
        turnCountAtStart: 0,
      };
      return {
        reply: {
          status: 202,
          body: {
            id: taskId,
            threadId,
            status: "running",
            tools,
            harness: task.harness,
            cwd: cwd.cwd,
            ...(requestedTools !== undefined && requestedTools !== tools
              ? { note: `tools narrowed to "${tools}" — the person allows this app at most that.` }
              : {}),
          },
        },
        task,
      };
    });

  const viewTask = (task: StoredAppTask): Effect.Effect<AppTaskView> =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(task.threadId);
      const shell = yield* deps.projections
        .getThreadShellById(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const base = {
        id: task.id,
        threadId: task.threadId,
        tools: task.tools,
        harness: task.harness,
        createdAt: task.createdAt,
      };
      if (Option.isNone(shell)) {
        return {
          ...base,
          status: "stopped",
          result: null,
          changedFiles: [],
          waitingFor: null,
          error: "The chat of this task was deleted in Work.",
        } satisfies AppTaskView;
      }
      const { status, waitingFor } = taskStatusFromShell(shell.value);
      const detail = yield* deps.projections
        .getThreadDetailById(threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const text = Option.isSome(detail) ? lastAssistantAnswer(detail.value) : null;
      return {
        ...base,
        status,
        result: text !== null && status !== "running" ? { text } : null,
        changedFiles: Option.isSome(detail)
          ? changedFilesOf(detail.value, task.turnCountAtStart)
          : [],
        waitingFor,
        error:
          status === "error"
            ? (shell.value.session?.lastError ?? "The agent stopped with an error.")
            : null,
      } satisfies AppTaskView;
    });

  const stopTask = (caller: AppTaskCaller, task: StoredAppTask) =>
    dispatch(
      {
        type: "thread.turn.interrupt",
        commandId: commandId("stop"),
        threadId: ThreadId.make(task.threadId),
        createdAt: new Date().toISOString(),
      },
      caller,
      task.id,
    ).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );

  const readDetail = (task: StoredAppTask) =>
    deps.projections
      .getThreadDetailById(ThreadId.make(task.threadId))
      .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThread>()));

  return { createTask, viewTask, stopTask, readDetail };
}

export type AppTasks = ReturnType<typeof makeAppTasks>;
