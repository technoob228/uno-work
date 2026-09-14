/**
 * Agent-threads bridge: lets any chat's agent spawn and drive other threads.
 *
 * Every handler takes the already-authorized bridge context (the scoped
 * harness token names the calling thread) and returns a plain
 * `{ status, body }` reply, so the HTTP layer stays a thin adapter and the
 * rules are testable with fake projections/engine.
 *
 * Trust boundary:
 * - the caller is ALWAYS the thread from the scoped token, never the body;
 * - every command is dispatched with origin `{ kind: "agent", threadId }`, so
 *   the decider enforces parentage/controller and the event store records who
 *   did it;
 * - read/write access is limited to threads whose `spawnedByThreadId` is the
 *   caller (anything else is 404, not 403 — no probing of foreign threads);
 * - a thread in another project only with `agentThreadsScope: "any-project"`.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationCommandOrigin,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProjectId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { Data, Effect, Option } from "effect";
import * as crypto from "node:crypto";

import type { BridgeAuthorization } from "../browserBridge.ts";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import { inheritProjectThreadModes } from "../orchestration/projectThreadModes.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  AGENT_THREAD_DEFAULT_MESSAGE_LIMIT,
  AGENT_THREAD_MAX_MESSAGE_LIMIT,
  AGENT_THREAD_MAX_TITLE_CHARS,
  AGENT_THREAD_MAX_WAIT_MS,
  AGENT_THREAD_MESSAGE_TEXT_CHARS,
  checkMessageText,
  clampInteger,
  defaultTitleFromText,
  deriveAgentThreadStatus,
  HUMAN_IN_CONTROL_MESSAGE,
  isCwdInsideOwnProject,
  lastAssistantText,
  messageAuthor,
  normalizeWorkspacePath,
  optionalString,
  resolveProviderModelSelection,
  threadController,
} from "./logic.ts";

export type AgentThreadsScope = "own-project" | "any-project";

export interface AgentThreadsReply {
  readonly status: number;
  readonly body: unknown;
}

export interface AgentThreadsDeps {
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly projections: Pick<
    ProjectionSnapshotQueryShape,
    | "getThreadShellById"
    | "getThreadDetailById"
    | "getProjectShellById"
    | "getShellSnapshot"
    | "getActiveProjectByWorkspaceRoot"
    | "getFirstActiveThreadIdByProjectId"
  >;
  readonly getAgentThreadsScope: Effect.Effect<AgentThreadsScope>;
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  /** Long-poll step; injectable so tests do not wait for real seconds. */
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Effect.Effect<void>;
  readonly nowMs?: () => number;
}

/** Short-circuit reply: raised inside a handler, rendered as-is. */
class Reply extends Data.TaggedError("AgentThreadsReply")<AgentThreadsReply> {}

const fail = (status: number, error: string, message: string) =>
  Effect.fail(new Reply({ status, body: { ok: false, error, message } }));

const ok = (body: Record<string, unknown>, status = 200): AgentThreadsReply => ({
  status,
  body: { ok: true, ...body },
});

const commandId = (tag: string) => CommandId.make(`agent:${tag}:${crypto.randomUUID()}`);

const THREAD_NOT_FOUND_BODY = {
  ok: false,
  error: "thread_not_found",
  message: "Тред не найден среди твоих.",
} as const;

/**
 * Maps a rejected dispatch to the bridge contract. The decider prefixes the
 * invariant details with a machine-readable reason (`human_in_control:` …).
 * Anything unrecognized is a server bug from the agent's point of view (the
 * bridge pre-checks what it can), so it is a 500, logged by the caller.
 */
export function replyForDispatchError(error: OrchestrationDispatchError): AgentThreadsReply {
  const detail =
    error._tag === "OrchestrationCommandInvariantError" ||
    error._tag === "OrchestrationCommandPreviouslyRejectedError"
      ? error.detail
      : "";
  const reason = /^([a-z_]+):/.exec(detail)?.[1];
  switch (reason) {
    case "human_in_control":
      return {
        status: 409,
        body: { ok: false, error: "human_in_control", message: HUMAN_IN_CONTROL_MESSAGE },
      };
    case "not_your_thread":
    case "not_agent_thread":
      return { status: 404, body: THREAD_NOT_FOUND_BODY };
    case "parent_thread_not_found":
      return {
        status: 404,
        body: {
          ok: false,
          error: "parent_thread_not_found",
          message: "Тред этой сессии не найден (удалён?).",
        },
      };
    case "agent_cannot_take_control":
      return {
        status: 403,
        body: {
          ok: false,
          error: "agent_cannot_take_control",
          message: "Агент может только отдать управление человеку, но не забрать его.",
        },
      };
    default:
      // Includes `spawn_origin_mismatch:` — the bridge always sends the
      // matching agent origin, so reaching it means a server bug.
      return {
        status: 500,
        body: { ok: false, error: "internal_error", message: "Не удалось выполнить команду." },
      };
  }
}

/** Only a thread-scoped bridge token identifies a caller. */
export function resolveCallerThreadId(
  authorization: BridgeAuthorization | null,
): { readonly ok: true; readonly threadId: ThreadId } | AgentThreadsReply {
  if (authorization === null) {
    return { status: 401, body: { ok: false, error: "unauthorized", message: "Unauthorized" } };
  }
  const threadId = authorization.context?.threadId;
  if (threadId === undefined || threadId.length === 0) {
    return {
      status: 403,
      body: {
        ok: false,
        error: "thread_context_required",
        message: "Нужен bridge-токен сессии треда ($UNO_WORK_BRIDGE_TOKEN внутри чата).",
      },
    };
  }
  return { ok: true, threadId: ThreadId.make(threadId) };
}

function asBody(body: unknown): Record<string, unknown> | null {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

export function makeAgentThreadsHandlers(deps: AgentThreadsDeps) {
  const pollIntervalMs = deps.pollIntervalMs ?? 1_000;
  const sleep = deps.sleep ?? ((ms: number) => Effect.sleep(ms));
  const nowMs = deps.nowMs ?? (() => Date.now());

  const run = (
    context: string,
    authorization: BridgeAuthorization | null,
    handler: (
      caller: OrchestrationThreadShell,
    ) => Effect.Effect<AgentThreadsReply, Reply | ProjectionRepositoryError>,
  ): Effect.Effect<AgentThreadsReply> => {
    const resolved = resolveCallerThreadId(authorization);
    if (!("ok" in resolved)) return Effect.succeed(resolved);
    return Effect.gen(function* () {
      const caller = yield* deps.projections.getThreadShellById(resolved.threadId);
      if (Option.isNone(caller)) {
        return yield* fail(
          403,
          "thread_context_required",
          "Тред этой сессии не найден (удалён?). Создавать и вести треды может только живой чат.",
        );
      }
      return yield* handler(caller.value);
    }).pipe(
      Effect.catch((error) =>
        error instanceof Reply
          ? Effect.succeed<AgentThreadsReply>({ status: error.status, body: error.body })
          : Effect.logError(`agent threads bridge failed: ${context}`, { cause: error }).pipe(
              Effect.as<AgentThreadsReply>({
                status: 500,
                body: { ok: false, error: "internal_error", message: "Внутренняя ошибка сервера." },
              }),
            ),
      ),
    );
  };

  const dispatch = (command: OrchestrationCommand, callerThreadId: ThreadId) => {
    const origin: OrchestrationCommandOrigin = { kind: "agent", threadId: callerThreadId };
    return deps.engine.dispatch(command, { origin }).pipe(
      Effect.catch((error) => {
        const reply = replyForDispatchError(error);
        return (
          reply.status >= 500
            ? Effect.logError("agent threads bridge: dispatch failed", {
                commandType: command.type,
                cause: error,
              })
            : Effect.void
        ).pipe(Effect.andThen(Effect.fail(new Reply(reply))));
      }),
    );
  };

  /** A child of the caller, or 404 — foreign threads are indistinguishable from absent ones. */
  const loadChild = (caller: OrchestrationThreadShell, rawThreadId: string | undefined) =>
    Effect.gen(function* () {
      const trimmed = rawThreadId?.trim() ?? "";
      if (trimmed.length === 0) {
        return yield* Effect.fail(new Reply({ status: 404, body: THREAD_NOT_FOUND_BODY }));
      }
      const shell = yield* deps.projections.getThreadShellById(ThreadId.make(trimmed));
      if (Option.isNone(shell) || (shell.value.spawnedByThreadId ?? null) !== caller.id) {
        return yield* Effect.fail(new Reply({ status: 404, body: THREAD_NOT_FOUND_BODY }));
      }
      return shell.value;
    });

  const resolveTargetProject = (
    caller: OrchestrationThreadShell,
    input: { readonly projectId: string | undefined; readonly cwd: string | undefined },
  ) =>
    Effect.gen(function* () {
      const ownProject = yield* deps.projections.getProjectShellById(caller.projectId);
      if (Option.isNone(ownProject)) {
        return yield* fail(404, "project_not_found", "Проект этого чата не найден.");
      }

      let target: OrchestrationProjectShell | null = null;
      if (input.projectId !== undefined) {
        if (input.projectId === caller.projectId) return ownProject.value;
        yield* requireAnyProjectScope;
        const found = yield* deps.projections.getProjectShellById(ProjectId.make(input.projectId));
        if (Option.isNone(found)) {
          return yield* fail(404, "project_not_found", `Проект "${input.projectId}" не найден.`);
        }
        target = found.value;
      } else if (input.cwd !== undefined) {
        if (
          isCwdInsideOwnProject({
            cwd: input.cwd,
            workspaceRoot: ownProject.value.workspaceRoot,
            worktreePath: caller.worktreePath,
          })
        ) {
          return ownProject.value;
        }
        const found = yield* deps.projections.getActiveProjectByWorkspaceRoot(
          normalizeWorkspacePath(input.cwd),
        );
        if (Option.isNone(found)) {
          return yield* fail(
            404,
            "project_not_found",
            `Нет проекта с корнем "${input.cwd}". Передай "projectId" или добавь папку как проект.`,
          );
        }
        if (found.value.id === caller.projectId) return ownProject.value;
        yield* requireAnyProjectScope;
        const shell = yield* deps.projections.getProjectShellById(found.value.id);
        if (Option.isNone(shell)) {
          return yield* fail(404, "project_not_found", `Нет проекта с корнем "${input.cwd}".`);
        }
        target = shell.value;
      }
      return target ?? ownProject.value;
    });

  const requireAnyProjectScope = Effect.gen(function* () {
    const scope = yield* deps.getAgentThreadsScope;
    if (scope !== "any-project") {
      return yield* fail(
        403,
        "project_not_allowed",
        "Создавать треды можно только в проекте этого чата. Другие проекты разрешает пользователь в Settings.",
      );
    }
  });

  const createThread = (authorization: BridgeAuthorization | null, rawBody: unknown) =>
    run("create", authorization, (caller) =>
      Effect.gen(function* () {
        const body = asBody(rawBody);
        if (body === null) {
          return yield* fail(
            400,
            "invalid_payload",
            'Ожидается JSON {"text": string, "title"?, "provider"?, "model"?, "projectId"?, "cwd"?}.',
          );
        }
        const text = checkMessageText(body.text);
        if (!text.ok) return yield* fail(400, "invalid_payload", text.message);
        const title = optionalString(body, "title", AGENT_THREAD_MAX_TITLE_CHARS);
        const provider = optionalString(body, "provider", 200);
        const model = optionalString(body, "model", 500);
        const projectId = optionalString(body, "projectId", 500);
        const cwd = optionalString(body, "cwd", 4096);
        if (!title.ok || !provider.ok || !model.ok || !projectId.ok || !cwd.ok) {
          return yield* fail(
            400,
            "invalid_payload",
            `Поля "title" (до ${AGENT_THREAD_MAX_TITLE_CHARS} символов), "provider", "model", "projectId", "cwd" — строки.`,
          );
        }

        const project = yield* resolveTargetProject(caller, {
          projectId: projectId.value,
          cwd: cwd.value,
        });
        const sameProject = project.id === caller.projectId;

        let modelSelection = sameProject ? caller.modelSelection : project.defaultModelSelection;
        if (provider.value !== undefined) {
          const providers = yield* deps.getProviders;
          const resolved = resolveProviderModelSelection({
            provider: provider.value,
            model: model.value,
            providers,
          });
          if (!resolved.ok) return yield* fail(400, "invalid_provider", resolved.message);
          modelSelection = resolved.selection;
        } else if (model.value !== undefined && modelSelection !== null) {
          modelSelection = { instanceId: modelSelection.instanceId, model: model.value };
        }
        if (modelSelection === null) {
          return yield* fail(
            400,
            "model_required",
            'У проекта нет модели по умолчанию — передай "provider" (например "codex" или "claudeAgent") и при желании "model".',
          );
        }

        const modes = sameProject
          ? { runtimeMode: caller.runtimeMode, interactionMode: caller.interactionMode }
          : yield* inheritProjectThreadModes(deps.projections, project.id);
        const threadTitle = title.value ?? defaultTitleFromText(text.value);
        const threadId = ThreadId.make(crypto.randomUUID());
        const createdAt = new Date(nowMs()).toISOString();

        yield* dispatch(
          {
            type: "thread.create",
            commandId: commandId("create"),
            threadId,
            projectId: project.id,
            title: threadTitle,
            modelSelection,
            runtimeMode: modes.runtimeMode,
            interactionMode: modes.interactionMode,
            branch: null,
            worktreePath: null,
            spawnedByThreadId: caller.id,
            createdAt,
          },
          caller.id,
        );
        yield* dispatch(
          {
            type: "thread.turn.start",
            commandId: commandId("turn"),
            threadId,
            message: {
              messageId: MessageId.make(crypto.randomUUID()),
              role: "user",
              text: text.value,
              attachments: [],
            },
            runtimeMode: modes.runtimeMode,
            interactionMode: modes.interactionMode,
            createdAt,
          },
          caller.id,
        );
        yield* Effect.logInfo("agent threads: thread spawned", {
          callerThreadId: caller.id,
          threadId,
          projectId: project.id,
          instanceId: modelSelection.instanceId,
          textPreview: text.value.slice(0, 80),
        });
        return ok({ threadId, projectId: project.id, title: threadTitle, controller: "agent" });
      }),
    );

  const listThreads = (authorization: BridgeAuthorization | null) =>
    run("list", authorization, (caller) =>
      Effect.gen(function* () {
        const snapshot = yield* deps.projections.getShellSnapshot();
        const children = snapshot.threads
          .filter((thread) => (thread.spawnedByThreadId ?? null) === caller.id)
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        const threads = yield* Effect.forEach(
          children,
          (child) =>
            deps.projections.getThreadDetailById(child.id).pipe(
              Effect.map((detail) => ({
                id: child.id,
                title: child.title,
                projectId: child.projectId,
                status: deriveAgentThreadStatus(child),
                controller: threadController(child),
                updatedAt: child.updatedAt,
                lastAssistantText: Option.isSome(detail)
                  ? lastAssistantText(detail.value.messages)
                  : null,
              })),
            ),
          { concurrency: 4 },
        );
        return { status: 200, body: { threads } } satisfies AgentThreadsReply;
      }),
    );

  const getThread = (
    authorization: BridgeAuthorization | null,
    input: {
      readonly threadId: string | undefined;
      readonly limit: string | null;
      readonly waitMs: string | null;
    },
  ) =>
    run("get", authorization, (caller) =>
      Effect.gen(function* () {
        let shell = yield* loadChild(caller, input.threadId);
        const limit = clampInteger(input.limit, {
          fallback: AGENT_THREAD_DEFAULT_MESSAGE_LIMIT,
          min: 1,
          max: AGENT_THREAD_MAX_MESSAGE_LIMIT,
        });
        const waitMs = clampInteger(input.waitMs, {
          fallback: 0,
          min: 0,
          max: AGENT_THREAD_MAX_WAIT_MS,
        });
        const deadline = nowMs() + waitMs;
        while (deriveAgentThreadStatus(shell) === "running" && nowMs() < deadline) {
          yield* sleep(Math.max(1, Math.min(pollIntervalMs, deadline - nowMs())));
          shell = yield* loadChild(caller, shell.id);
        }

        const detail = yield* deps.projections.getThreadDetailById(shell.id);
        const messages = Option.isSome(detail) ? detail.value.messages.slice(-limit) : [];
        return {
          status: 200,
          body: {
            id: shell.id,
            title: shell.title,
            projectId: shell.projectId,
            status: deriveAgentThreadStatus(shell),
            controller: threadController(shell),
            controlChangedAt: shell.controlChangedAt ?? null,
            pendingApproval: shell.hasPendingApprovals,
            pendingUserInput: shell.hasPendingUserInput,
            messages: messages.map((message) => {
              const view: Record<string, unknown> = {
                role: message.role,
                author: messageAuthor(message, caller.id),
                text: message.text.slice(0, AGENT_THREAD_MESSAGE_TEXT_CHARS),
                createdAt: message.createdAt,
              };
              if (message.text.length > AGENT_THREAD_MESSAGE_TEXT_CHARS) view.truncated = true;
              return view;
            }),
          },
        } satisfies AgentThreadsReply;
      }),
    );

  const sendMessage = (
    authorization: BridgeAuthorization | null,
    input: { readonly threadId: string | undefined; readonly body: unknown },
  ) =>
    run("send", authorization, (caller) =>
      Effect.gen(function* () {
        const child = yield* loadChild(caller, input.threadId);
        const body = asBody(input.body);
        const text = checkMessageText(body?.text);
        if (!text.ok) return yield* fail(400, "invalid_payload", text.message);
        if (threadController(child) !== "agent") {
          return yield* fail(409, "human_in_control", HUMAN_IN_CONTROL_MESSAGE);
        }
        yield* dispatch(
          {
            type: "thread.turn.start",
            commandId: commandId("turn"),
            threadId: child.id,
            message: {
              messageId: MessageId.make(crypto.randomUUID()),
              role: "user",
              text: text.value,
              attachments: [],
            },
            runtimeMode: child.runtimeMode,
            interactionMode: child.interactionMode,
            createdAt: new Date(nowMs()).toISOString(),
          },
          caller.id,
        );
        yield* Effect.logInfo("agent threads: message sent", {
          callerThreadId: caller.id,
          threadId: child.id,
          textPreview: text.value.slice(0, 80),
        });
        return ok({});
      }),
    );

  const releaseThread = (
    authorization: BridgeAuthorization | null,
    input: { readonly threadId: string | undefined },
  ) =>
    run("release", authorization, (caller) =>
      Effect.gen(function* () {
        const child = yield* loadChild(caller, input.threadId);
        // Always dispatch: the decider is idempotent for an unchanged
        // controller, and it stays the single source of truth.
        yield* dispatch(
          {
            type: "thread.control.set",
            commandId: commandId("release"),
            threadId: child.id,
            controller: "human",
            createdAt: new Date(nowMs()).toISOString(),
          },
          caller.id,
        );
        yield* Effect.logInfo("agent threads: control released", {
          callerThreadId: caller.id,
          threadId: child.id,
        });
        return ok({ controller: "human" });
      }),
    );

  return { createThread, listThreads, getThread, sendMessage, releaseThread };
}
