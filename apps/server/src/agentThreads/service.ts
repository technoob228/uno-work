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
 * - read/write reaches any live thread of the caller's project, other projects
 *   only with `agentThreadsScope: "any-project"` (anything else is 404, not
 *   403 — no probing of foreign threads); release stays parent-only;
 * - an agent never writes into a thread that waits for the human, and nobody
 *   writes into a chat the person closed to agents; a human having written in
 *   a chat does not lock agents out (0.0.115);
 * - an agent never widens its own permissions: a spawned thread runs in at
 *   most the caller's runtime mode, and a turn is never started in a thread
 *   whose runtime mode is wider than the caller's (403 runtime_mode_escalation).
 */
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationCommandOrigin,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ProjectId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { findMarkedAssistantChat, isAssistantConversation } from "@t3tools/shared/assistantChat";
import {
  ASSISTANT_PRESET_COPY,
  allowlistReaches,
  assistantPresetAllows,
  capRuntimeToPreset,
} from "@t3tools/shared/assistantPreset";
import { Data, Effect, Option } from "effect";
import * as crypto from "node:crypto";

import { requireBridgeThread, type BridgeAuthorization } from "../browserBridge.ts";
import type { AssistantAccessView } from "../assistants/assistantAccess.ts";
import { checkTargetComputer } from "../assistants/targetComputer.ts";
import {
  applyPersonRoute,
  readPersonRoute,
  selectionNotReadyMessage,
} from "../manager/personRouting.ts";
import type {
  RemoteChatStarted,
  RemoteChatStartInput,
  RemoteTarget,
} from "../remoteComputers/RemoteComputers.ts";
import type { RemoteComputerError } from "../remoteComputers/remoteDaemonClient.ts";
import {
  portableFolder,
  remoteChatPermission,
  remoteChatStartedNote,
} from "../remoteComputers/remoteChatPolicy.ts";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import {
  capRuntimeMode,
  inheritProjectThreadModes,
  isRuntimeModeWider,
} from "../orchestration/projectThreadModes.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  AGENT_THREAD_DEFAULT_MESSAGE_LIMIT,
  AGENT_THREAD_MAX_MESSAGE_LIMIT,
  AGENT_THREAD_MAX_TITLE_CHARS,
  AGENT_THREAD_MAX_WAIT_MS,
  AGENT_THREAD_MESSAGE_TEXT_CHARS,
  type AgentThreadListScope,
  bodyWaitMs,
  checkMessageText,
  clampInteger,
  defaultTitleFromText,
  deriveAgentThreadStatus,
  agentDeliveryBlock,
  AGENTS_CLOSED_MESSAGE,
  isCwdInsideOwnProject,
  lastAssistantText,
  messageAuthor,
  normalizeWorkspacePath,
  optionalString,
  parseListScope,
  resolveProviderModelSelection,
  isClosedToAgents,
  isPinnedAssistantChat,
  threadController,
  threadRelation,
} from "./logic.ts";

export type AgentThreadsScope = "own-project" | "any-project";

export interface AgentThreadsRemoteDeps {
  readonly resolveTarget: (computerId: unknown) => Effect.Effect<RemoteTarget, RemoteComputerError>;
  readonly startChat: (
    input: RemoteChatStartInput,
  ) => Effect.Effect<RemoteChatStarted, RemoteComputerError>;
  /** The assistant's name as the person sees it. */
  readonly assistantName: (projectId: string) => Effect.Effect<string>;
  /** Report the chat's outcome back to the assistant's conversation (assistantPush). */
  readonly watch: (input: {
    readonly threadId: string;
    readonly assistantProjectId: string;
    readonly conversationThreadId: string;
    readonly boxId: number;
    readonly computerName: string;
  }) => Effect.Effect<void>;
  /** This computer's home, to send a local project's folder portably. */
  readonly home: string;
}

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
  /**
   * The assistant the calling chat belongs to — its workspace, a chat it
   * started, or a chat one of those started — with its preset and projects
   * (`assistants/assistantAccess.ts`); null for the person's own chats.
   * An assistant's conversations reach its projects instead of the global
   * `getAgentThreadsScope`; chats it started keep that setting and are
   * narrowed to its projects. Absent: an assistant conversation reaches only
   * its own workspace (no token never widens access).
   */
  readonly getCallerAssistant?: (
    caller: OrchestrationThreadShell,
  ) => Effect.Effect<AssistantAccessView | null>;
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  /** Settings `harnessUnoCredits` (Claude Code on Uno credits allowed here). Absent: {}. */
  readonly getHarnessUnoCredits?: Effect.Effect<Readonly<Record<string, boolean>>>;
  /**
   * This computer's box id (null on a laptop): the only `computerId` a new
   * thread may name for now (assistants/targetComputer.ts). Absent = null.
   */
  readonly getOwnBoxId?: Effect.Effect<number | null>;
  /**
   * Chats on another computer of the account (`remoteComputers/`). Absent:
   * only this computer (the old `checkTargetComputer` rule).
   */
  readonly remote?: AgentThreadsRemoteDeps;
  /**
   * A folder of this computer that is no project yet, made one now (an
   * existing folder in the home folder, not hidden, not an assistant's) —
   * so a task for ~/projects/<x> starts even when the person never added
   * <x> to Uno Work (Misha 29.10, the luckyip case). Null: not such a folder.
   * Only for a caller that reaches every project. Absent: no registration.
   */
  readonly registerFolder?: (cwd: string) => Effect.Effect<OrchestrationProjectShell | null>;
  /**
   * What a chat an assistant starts without naming a model runs on: the
   * account's default AI when usable here (as create_thread). Absent / null:
   * the project's default.
   */
  readonly personalDefault?: Effect.Effect<ModelSelection | null>;
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

const expandHome = (raw: string, home: string) =>
  raw === "~" ? home : raw.startsWith("~/") ? `${home}${raw.slice(1)}` : raw;

const commandId = (tag: string) => CommandId.make(`agent:${tag}:${crypto.randomUUID()}`);

const THREAD_NOT_FOUND_BODY = {
  ok: false,
  error: "thread_not_found",
  message: "Тред не найден среди доступных тебе.",
} as const;

/**
 * Maps a rejected dispatch to the bridge contract. The decider prefixes the
 * invariant details with a machine-readable reason (`agents_closed:` …).
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
    case "agents_closed":
      return {
        status: 409,
        body: { ok: false, error: "agents_closed", message: AGENTS_CLOSED_MESSAGE },
      };
    case "cannot_message_self":
      return {
        status: 400,
        body: { ok: false, error: "cannot_message_self", message: "Нельзя написать самому себе." },
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
  const resolved = requireBridgeThread(authorization);
  if (!resolved.ok) {
    return {
      status: resolved.status,
      body: { ok: false, error: resolved.error, message: resolved.message },
    };
  }
  return { ok: true, threadId: ThreadId.make(resolved.threadId) };
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

  /**
   * Which projects the caller may reach, and on whose behalf it acts:
   *
   * - the person's own chat: its project, others with the person's
   *   agent-threads setting;
   * - an assistant's conversation (its workspace, or Uno's pinned chat):
   *   that assistant's projects (its preset page / Settings → Assistant →
   *   "Can see and manage"), as uno-manager enforces them;
   * - a chat an assistant started: the person's setting, never beyond that
   *   assistant's projects.
   */
  // Handlers live for one request: whose chat the caller is is looked up
  // once, not on every long-poll step.
  const assistantByCaller = new Map<string, AssistantAccessView | null>();
  const callerAssistant = (caller: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      const cached = assistantByCaller.get(caller.id);
      if (cached !== undefined) return cached;
      const found = deps.getCallerAssistant ? yield* deps.getCallerAssistant(caller) : null;
      assistantByCaller.set(caller.id, found);
      return found;
    });

  const callerAccess = (caller: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      const assistant = yield* callerAssistant(caller);
      const conversation =
        isAssistantConversation(caller) ||
        (assistant !== null && caller.projectId === assistant.projectId);
      if (conversation) {
        return {
          assistant,
          // Lists every project it may reach (scope "all").
          wide: true,
          allowed: (projectId: string) =>
            projectId === caller.projectId ||
            (assistant !== null &&
              allowlistReaches(assistant.allowlist, projectId, assistant.projectId)),
        };
      }
      const scope = yield* deps.getAgentThreadsScope;
      return {
        assistant,
        wide: scope === "any-project",
        allowed: (projectId: string) =>
          (projectId === caller.projectId || scope === "any-project") &&
          (assistant === null ||
            allowlistReaches(assistant.allowlist, projectId, assistant.projectId)),
      };
    });

  const projectAccess = (caller: OrchestrationThreadShell) =>
    callerAccess(caller).pipe(Effect.map((access) => access.allowed));

  /**
   * The preset of the assistant the caller acts for refuses `action` (403),
   * and the widest mode the chats it starts or steers may run in.
   */
  const presetCheck = (
    assistant: AssistantAccessView | null,
    action: "start-chat" | "write-chat",
  ) => {
    if (assistant === null || assistantPresetAllows(assistant.preset, action)) {
      return Effect.void;
    }
    const copy = ASSISTANT_PRESET_COPY[assistant.preset];
    return fail(
      403,
      "assistant_preset_denied",
      `Your access is "${copy.name}": ${copy.line} Tell the person what you would do; they can change your access on your page in Uno Work. Don't retry or work around it.`,
    );
  };

  /** The caller's own mode, narrowed to its assistant's preset (Helper: approval-required). */
  const effectiveRuntime = (
    caller: OrchestrationThreadShell,
    assistant: AssistantAccessView | null,
  ) =>
    assistant === null
      ? caller.runtimeMode
      : capRuntimeToPreset(caller.runtimeMode, assistant.preset);

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

  /**
   * Any live thread the caller may talk to: its own project, or any project
   * when the user allowed it. Archived and out-of-scope threads are 404.
   */
  const loadReachable = (
    caller: OrchestrationThreadShell,
    rawThreadId: string | undefined,
    options: {
      /**
       * Writing to the person's pinned assistant chat ("Uno") is open to every
       * chat, whatever its project; reading its transcript is not (it holds
       * the person's private conversation, Telegram included).
       */
      readonly assistantChat?: boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      const trimmed = rawThreadId?.trim() ?? "";
      const notFound = Effect.fail(new Reply({ status: 404, body: THREAD_NOT_FOUND_BODY }));
      if (trimmed.length === 0) return yield* notFound;
      const shell = yield* deps.projections.getThreadShellById(ThreadId.make(trimmed));
      if (Option.isNone(shell) || shell.value.archivedAt !== null) return yield* notFound;
      const isAssistantChat = options.assistantChat === true && isPinnedAssistantChat(shell.value);
      if (!isAssistantChat && !(yield* projectAccess(caller))(shell.value.projectId)) {
        return yield* notFound;
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
        yield* requireProjectAllowed(caller, input.projectId);
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
          // A brand-new project is one the caller may use only when it
          // reaches every project (the person's "all projects").
          const reachesAll = (yield* callerAccess(caller)).allowed(crypto.randomUUID());
          const registered =
            reachesAll && deps.registerFolder ? yield* deps.registerFolder(input.cwd) : null;
          if (registered !== null) return registered;
          return yield* fail(
            404,
            "project_not_found",
            `Нет проекта с корнем "${input.cwd}". Передай "projectId" или добавь папку как проект.`,
          );
        }
        if (found.value.id === caller.projectId) return ownProject.value;
        yield* requireProjectAllowed(caller, found.value.id);
        const shell = yield* deps.projections.getProjectShellById(found.value.id);
        if (Option.isNone(shell)) {
          return yield* fail(404, "project_not_found", `Нет проекта с корнем "${input.cwd}".`);
        }
        target = shell.value;
      }
      return target ?? ownProject.value;
    });

  const requireProjectAllowed = (caller: OrchestrationThreadShell, projectId: string) =>
    Effect.gen(function* () {
      const access = yield* callerAccess(caller);
      if (access.allowed(projectId)) return;
      return yield* fail(
        403,
        "project_not_allowed",
        isAssistantConversation(caller) || access.assistant !== null
          ? "This project is outside the projects the person lets this assistant work in (its page in Uno Work, or Settings → Assistant for Uno)."
          : "Создавать треды можно только в проекте этого чата. Другие проекты разрешает пользователь в Settings.",
      );
    });

  /**
   * The chat goes to another computer of the account: same preset check,
   * the assistant's "selected projects" boundary stays here (refused), the
   * mode never wider than the caller's own. A conversation of an assistant
   * hears the outcome by itself (assistantPush remote watch).
   */
  const startRemote = (
    caller: OrchestrationThreadShell,
    remote: AgentThreadsRemoteDeps,
    target: { readonly boxId: number; readonly name: string },
    input: {
      readonly text: string;
      readonly title: string | undefined;
      readonly provider: string | undefined;
      readonly model: string | undefined;
      readonly projectId: string | undefined;
      readonly cwd: string | undefined;
    },
  ) =>
    Effect.gen(function* () {
      const { assistant } = yield* callerAccess(caller);
      yield* presetCheck(assistant, "start-chat");
      const assistantName =
        assistant === null ? null : yield* remote.assistantName(assistant.projectId);
      const permission = remoteChatPermission({
        allowlist: assistant === null ? null : assistant.allowlist,
        assistantName,
        computerName: target.name,
      });
      if (!permission.ok) return yield* fail(403, permission.code, permission.message);
      // A project of THIS computer named by id goes as its folder: synced
      // projects keep the same folder under the home on every computer.
      let cwd = input.cwd;
      let projectId = input.projectId;
      if (projectId !== undefined) {
        const local = yield* deps.projections.getProjectShellById(ProjectId.make(projectId));
        if (Option.isSome(local)) {
          cwd = portableFolder(local.value.workspaceRoot, remote.home);
          projectId = undefined;
        }
      }
      const started = yield* remote
        .startChat({
          target,
          text: input.text,
          title: input.title,
          cwd,
          projectId,
          provider: input.provider,
          model: input.model,
          runtimeMode: effectiveRuntime(caller, assistant),
          startedBy: {
            assistantName: assistantName ?? `Chat “${caller.title}”`,
            assistantProjectId: assistant?.projectId ?? null,
            fromThreadId: caller.id,
            preset: assistant?.preset ?? null,
          },
        })
        .pipe(
          Effect.catch((error) =>
            fail(error.code === "not_found" ? 404 : 409, `computer_${error.code}`, error.message),
          ),
        );
      const conversation =
        assistant !== null &&
        (isAssistantConversation(caller) || caller.projectId === assistant.projectId);
      if (conversation) {
        yield* remote.watch({
          threadId: started.threadId,
          assistantProjectId: assistant.projectId,
          conversationThreadId: caller.id,
          boxId: target.boxId,
          computerName: target.name,
        });
      }
      return ok({
        threadId: started.threadId,
        projectId: started.projectId,
        title: started.title,
        computer: { id: target.boxId, name: target.name },
        controller: "agent",
        note: remoteChatStartedNote(target.name, conversation),
      });
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
        const rawCwd = optionalString(body, "cwd", 4096);
        const taskType = optionalString(body, "taskType", 200);
        if (!title.ok || !provider.ok || !model.ok || !projectId.ok || !rawCwd.ok || !taskType.ok) {
          return yield* fail(
            400,
            "invalid_payload",
            `Поля "title" (до ${AGENT_THREAD_MAX_TITLE_CHARS} символов), "provider", "model", "projectId", "cwd", "taskType" — строки.`,
          );
        }
        if (deps.remote === undefined) {
          const target = checkTargetComputer(
            body.computerId,
            deps.getOwnBoxId ? yield* deps.getOwnBoxId : null,
          );
          if (!target.ok) return yield* fail(403, target.code, target.message);
        } else {
          const remote = deps.remote;
          const target = yield* remote
            .resolveTarget(body.computerId)
            .pipe(
              Effect.catch((error) =>
                fail(
                  error.code === "not_found" ? 404 : 409,
                  `computer_${error.code}`,
                  error.message,
                ),
              ),
            );
          if (target.kind === "box") {
            return yield* startRemote(caller, remote, target, {
              text: text.value,
              title: title.value,
              provider: provider.value,
              model: model.value,
              projectId: projectId.value,
              cwd: rawCwd.value,
            });
          }
        }
        // A folder sent for another computer comes unexpanded ("~/site").
        const cwd =
          rawCwd.value !== undefined && deps.remote !== undefined
            ? expandHome(rawCwd.value, deps.remote.home)
            : rawCwd.value;

        const { assistant } = yield* callerAccess(caller);
        yield* presetCheck(assistant, "start-chat");
        const project = yield* resolveTargetProject(caller, {
          projectId: projectId.value,
          cwd,
        });
        const sameProject = project.id === caller.projectId;

        // Order (personRouting.ts): the person's routing rows → what the
        // model named (first when the person asked for it) → the account's
        // default AI → the project's default.
        let modelSelection = sameProject ? caller.modelSelection : project.defaultModelSelection;
        let requested: ModelSelection | null = null;
        if (provider.value !== undefined) {
          const providers = yield* deps.getProviders;
          const resolved = resolveProviderModelSelection({
            provider: provider.value,
            model: model.value,
            providers,
          });
          if (!resolved.ok) return yield* fail(400, "invalid_provider", resolved.message);
          requested = resolved.selection;
        } else if (model.value !== undefined && modelSelection !== null) {
          requested = { instanceId: modelSelection.instanceId, model: model.value };
        }
        const assistantProjectId =
          assistant?.projectId ?? (isAssistantConversation(caller) ? caller.projectId : null);
        if (assistantProjectId !== null) {
          const assistantProject = yield* deps.projections
            .getProjectShellById(ProjectId.make(assistantProjectId))
            .pipe(Effect.orElseSucceed(() => Option.none()));
          const route = Option.isSome(assistantProject)
            ? yield* Effect.promise(() =>
                readPersonRoute(assistantProject.value.workspaceRoot, taskType.value),
              )
            : null;
          const routed = applyPersonRoute({
            route,
            requested,
            personAsked: body.personAsked === true,
            providers: route === null ? [] : yield* deps.getProviders,
          });
          if (routed.kind === "not-ready") {
            return yield* fail(409, "harness_not_ready", routed.message);
          }
          if (routed.kind === "selection") requested = routed.selection;
          else if (
            requested === null &&
            deps.personalDefault !== undefined &&
            caller.projectId === assistantProjectId
          ) {
            requested = yield* deps.personalDefault;
          }
        }
        if (requested !== null) modelSelection = requested;
        if (modelSelection === null) {
          return yield* fail(
            400,
            "model_required",
            'У проекта нет модели по умолчанию — передай "provider" (например "codex" или "claudeAgent") и при желании "model".',
          );
        }
        // An assistant's chat on a harness that can't start here is not
        // started at all: the model hears why and asks the person.
        if (assistantProjectId !== null) {
          const notReady = selectionNotReadyMessage(
            modelSelection,
            yield* deps.getProviders,
            deps.getHarnessUnoCredits === undefined ? {} : yield* deps.getHarnessUnoCredits,
          );
          if (notReady !== null) return yield* fail(409, "harness_not_ready", notReady);
        }

        const inherited = sameProject
          ? { runtimeMode: caller.runtimeMode, interactionMode: caller.interactionMode }
          : yield* inheritProjectThreadModes(deps.projections, project.id);
        // Never spawn a thread with more permissions than the caller has
        // (nor than its assistant's preset allows).
        const modes = {
          ...inherited,
          runtimeMode: capRuntimeMode(inherited.runtimeMode, effectiveRuntime(caller, assistant)),
        };
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

  const listThreads = (
    authorization: BridgeAuthorization | null,
    input: { readonly scope: string | null } = { scope: null },
  ) =>
    run("list", authorization, (caller) =>
      Effect.gen(function* () {
        const scope: AgentThreadListScope | null = parseListScope(input.scope);
        if (scope === null) {
          return yield* fail(
            400,
            "invalid_scope",
            '"scope" — "children" (по умолчанию), "project" или "all".',
          );
        }
        const { allowed, wide } = yield* callerAccess(caller);
        // The assistant lists whatever it may see; any other chat needs the
        // person's "any project" setting for "all".
        if (scope === "all" && !wide) {
          return yield* fail(
            403,
            "project_not_allowed",
            "Создавать треды можно только в проекте этого чата. Другие проекты разрешает пользователь в Settings.",
          );
        }
        const snapshot = yield* deps.projections.getShellSnapshot();
        const listed = snapshot.threads
          .filter((thread) =>
            scope === "children"
              ? (thread.spawnedByThreadId ?? null) === caller.id && allowed(thread.projectId)
              : thread.archivedAt === null &&
                (scope === "all"
                  ? allowed(thread.projectId)
                  : thread.projectId === caller.projectId),
          )
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        // The person's assistant chat is always there to write to (relation
        // "assistant"), first; its last answer only when the caller may read
        // its project anyway.
        const assistantChat = findMarkedAssistantChat(snapshot.threads);
        const withAssistant =
          assistantChat !== null &&
          assistantChat.archivedAt === null &&
          assistantChat.id !== caller.id &&
          !listed.some((thread) => thread.id === assistantChat.id);
        const selected = withAssistant ? [assistantChat, ...listed] : listed;
        const canRead = (thread: OrchestrationThreadShell) =>
          !isPinnedAssistantChat(thread) || allowed(thread.projectId);
        const threads = yield* Effect.forEach(
          selected,
          (child) =>
            (canRead(child)
              ? deps.projections.getThreadDetailById(child.id)
              : Effect.succeed(Option.none<OrchestrationThread>())
            ).pipe(
              Effect.map((detail) => ({
                id: child.id,
                title: child.title,
                projectId: child.projectId,
                provider: child.modelSelection.instanceId,
                relation: threadRelation(caller, child),
                spawnedByThreadId: child.spawnedByThreadId ?? null,
                status: deriveAgentThreadStatus(child),
                controller: threadController(child),
                agentsClosed: isClosedToAgents(child),
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
        let shell = yield* loadReachable(caller, input.threadId);
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
          shell = yield* loadReachable(caller, shell.id);
        }

        const detail = yield* deps.projections.getThreadDetailById(shell.id);
        const messages = Option.isSome(detail) ? detail.value.messages.slice(-limit) : [];
        return {
          status: 200,
          body: {
            id: shell.id,
            title: shell.title,
            projectId: shell.projectId,
            provider: shell.modelSelection.instanceId,
            relation: threadRelation(caller, shell),
            status: deriveAgentThreadStatus(shell),
            controller: threadController(shell),
            controlChangedAt: shell.controlChangedAt ?? null,
            agentsClosed: isClosedToAgents(shell),
            pendingApproval: shell.hasPendingApprovals,
            pendingUserInput: shell.hasPendingUserInput,
            messages: messages.map((message) => {
              const view: Record<string, unknown> = {
                role: message.role,
                author: messageAuthor(message, caller.id),
                ...(message.role === "user" &&
                message.sentByThreadId != null &&
                message.sentByThreadId !== caller.id
                  ? { fromThreadId: message.sentByThreadId }
                  : {}),
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
        const { assistant } = yield* callerAccess(caller);
        yield* presetCheck(assistant, "write-chat");
        const callerMode = effectiveRuntime(caller, assistant);
        let target = yield* loadReachable(caller, input.threadId, { assistantChat: true });
        if (target.id === caller.id) {
          return yield* fail(400, "cannot_message_self", "Нельзя написать самому себе.");
        }
        const body = asBody(input.body);
        const text = checkMessageText(body?.text);
        if (!text.ok) return yield* fail(400, "invalid_payload", text.message);

        // Only a running turn is worth waiting for: a closed chat or a
        // pending approval does not clear on its own within a request.
        const waitMs = bodyWaitMs(body?.waitMs);
        const startedMs = nowMs();
        const deadline = startedMs + waitMs;
        let block = agentDeliveryBlock(caller, target);
        while (block?.error === "target_busy" && nowMs() < deadline) {
          yield* sleep(Math.max(1, Math.min(pollIntervalMs, deadline - nowMs())));
          target = yield* loadReachable(caller, target.id, { assistantChat: true });
          block = agentDeliveryBlock(caller, target);
        }
        if (block !== null) return yield* fail(block.status, block.error, block.message);
        // The decider runs the turn in the target's own mode, so a caller may
        // not drive a thread that is allowed more than the caller itself.
        if (isRuntimeModeWider(target.runtimeMode, callerMode)) {
          return yield* fail(
            403,
            "runtime_mode_escalation",
            `Этот тред работает в режиме "${target.runtimeMode}", шире твоего ("${callerMode}"). Писать в него может только человек.`,
          );
        }

        yield* dispatch(
          {
            type: "thread.turn.start",
            commandId: commandId("turn"),
            threadId: target.id,
            message: {
              messageId: MessageId.make(crypto.randomUUID()),
              role: "user",
              text: text.value,
              attachments: [],
            },
            runtimeMode: capRuntimeMode(target.runtimeMode, callerMode),
            interactionMode: target.interactionMode,
            createdAt: new Date(nowMs()).toISOString(),
          },
          caller.id,
        );
        const relation = threadRelation(caller, target);
        yield* Effect.logInfo("agent threads: message sent", {
          callerThreadId: caller.id,
          threadId: target.id,
          relation,
          waitedMs: nowMs() - startedMs,
          textPreview: text.value.slice(0, 80),
        });
        return ok({ threadId: target.id, relation });
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
