/**
 * The receiving side of "an assistant starts a chat on another computer"
 * (assistants D, 28.10): what this daemon does when the daemon of another
 * computer of the same account, paired as an owner through the console,
 * calls
 *
 * - `POST /api/manager/remote-chats`          — start a chat here and its first turn;
 * - `GET  /api/manager/remote-chats/:threadId` — one status line of such a chat;
 * - `GET  /api/manager/started-by`            — chats here an assistant started
 *   (this computer's assistants, and other computers' through the ledger),
 *   for the sidebar's "started by <name>".
 *
 * Rules:
 * - the chat lands in a project of THIS computer: by `projectId`, by `cwd`,
 *   or the project used last; never an assistant's own workspace;
 * - it runs in at most the caller's `runtimeMode` (absent: Ask mode) and
 *   never wider than the project's chats already run;
 * - the turn carries a system origin (`remote-chat`), so no local watcher
 *   mistakes it for the person;
 * - status is readable only for chats that arrived this way.
 *
 * Handlers return `{ status, body }`; the HTTP layer is a thin adapter.
 *
 * @module remoteComputers/remoteChatHost
 */
import * as os from "node:os";

import {
  ASSISTANT_PROJECT_ID,
  CommandId,
  isAssistantProjectId,
  type ManagerRemoteChatCreateInput,
  type ManagerRemoteChatResult,
  type ManagerRemoteChatStatus,
  type ManagerStartedByEntry,
  MessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProjectId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";
import * as crypto from "node:crypto";

import {
  defaultTitleFromText,
  lastAssistantText,
  normalizeWorkspacePath,
  resolveProviderModelSelection,
} from "../agentThreads/logic.ts";
import { owningAssistant } from "../assistants/localAssistantStore.ts";
import { isAssistantConversationThread } from "../manager/assistantPush.ts";
import { workStatusState } from "../manager/workStatus.ts";
import { systemCommandOrigin } from "../orchestration/commandOrigin.ts";
import { capRuntimeMode, inheritProjectThreadModes } from "../orchestration/projectThreadModes.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { IncomingRemoteChat } from "./remoteChatStore.ts";

/** Component of the system origin every remote chat command carries. */
export const REMOTE_CHAT_ORIGIN_COMPONENT = "remote-chat";
/** How much of the last answer a status line carries. */
export const REMOTE_CHAT_LAST_MESSAGE_CHARS = 600;
const MAX_TEXT_CHARS = 20_000;
const MAX_TITLE_CHARS = 120;

export interface RemoteChatHostReply {
  readonly status: number;
  readonly body: unknown;
}

export interface RemoteChatHostDeps {
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly projections: Pick<
    ProjectionSnapshotQueryShape,
    | "getShellSnapshot"
    | "getThreadShellById"
    | "getThreadDetailById"
    | "getProjectShellById"
    | "getActiveProjectByWorkspaceRoot"
    | "getFirstActiveThreadIdByProjectId"
  >;
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;
  readonly incoming: {
    readonly record: (entry: IncomingRemoteChat) => Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<IncomingRemoteChat>>;
  };
  /** Which assistant of this computer started which chat (`create_thread` ledger). */
  readonly startedChats: Effect.Effect<ReadonlyMap<string, string>>;
  /** An assistant's name as the person sees it (team name, else its project title). */
  readonly assistantName: (projectId: string, projectTitle: string) => Effect.Effect<string>;
  readonly home?: string;
  readonly nowMs?: () => number;
}

const fail = (status: number, error: string, message: string): RemoteChatHostReply => ({
  status,
  body: { ok: false, error, message },
});

const expandHome = (raw: string, home: string) =>
  raw === "~" ? home : raw.startsWith("~/") ? `${home}${raw.slice(1)}` : raw;

/** The project a chat without `projectId` / `cwd` lands in: the person's project used last. */
export function defaultProjectFor(
  projects: ReadonlyArray<Pick<OrchestrationProjectShell, "id" | "updatedAt">>,
  threads: ReadonlyArray<Pick<OrchestrationThreadShell, "projectId" | "updatedAt" | "archivedAt">>,
): ProjectId | null {
  const lastUse = new Map<string, string>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const seen = lastUse.get(thread.projectId);
    if (seen === undefined || thread.updatedAt > seen)
      lastUse.set(thread.projectId, thread.updatedAt);
  }
  const candidates = projects
    .filter((project) => !isAssistantProjectId(project.id))
    .map((project) => ({
      id: project.id,
      at: lastUse.get(project.id) ?? project.updatedAt,
    }))
    .toSorted((a, b) => b.at.localeCompare(a.at));
  return candidates[0]?.id ?? null;
}

/**
 * What a project without a default AI runs on: what its newest chat ran on,
 * else the newest chat of this computer (the person's last pick).
 */
export function lastUsedModel(
  threads: ReadonlyArray<
    Pick<OrchestrationThreadShell, "projectId" | "updatedAt" | "archivedAt" | "modelSelection">
  >,
  projectId: string,
): ModelSelection | null {
  const live = threads
    .filter((thread) => thread.archivedAt === null && !isAssistantProjectId(thread.projectId))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    live.find((thread) => thread.projectId === projectId)?.modelSelection ??
    live[0]?.modelSelection ??
    null
  );
}

/** `ManagerWorkStatusState` → the remote status word the caller reads. */
export function remoteStateWord(state: ReturnType<typeof workStatusState>): string {
  switch (state) {
    case "needs_you":
      return "waiting-for-you";
    default:
      return state;
  }
}

const isReply = (value: unknown): value is RemoteChatHostReply =>
  typeof value === "object" && value !== null && "status" in value && "body" in value;

export function makeRemoteChatHost(deps: RemoteChatHostDeps) {
  const home = deps.home ?? os.homedir();
  const nowMs = deps.nowMs ?? (() => Date.now());

  const resolveProject = (input: ManagerRemoteChatCreateInput) =>
    Effect.gen(function* () {
      if (input.projectId !== undefined && input.projectId.trim().length > 0) {
        const id = ProjectId.make(input.projectId.trim());
        if (isAssistantProjectId(id)) {
          return fail(
            403,
            "project_not_allowed",
            "An assistant's own folder can't take chats from another computer.",
          );
        }
        const found = yield* deps.projections.getProjectShellById(id);
        return Option.isSome(found)
          ? found.value
          : fail(
              404,
              "project_not_found",
              `There is no project "${input.projectId}" on this computer.`,
            );
      }
      if (input.cwd !== undefined && input.cwd.trim().length > 0) {
        const root = normalizeWorkspacePath(expandHome(input.cwd.trim(), home));
        const found = yield* deps.projections.getActiveProjectByWorkspaceRoot(root);
        if (Option.isNone(found) || isAssistantProjectId(found.value.id)) {
          return fail(
            404,
            "project_not_found",
            `There is no project at ${input.cwd.trim()} on this computer. Leave the folder out to use the project used last, or ask the person to open that folder there first.`,
          );
        }
        const shell = yield* deps.projections.getProjectShellById(found.value.id);
        return Option.isSome(shell)
          ? shell.value
          : fail(
              404,
              "project_not_found",
              `There is no project at ${input.cwd.trim()} on this computer.`,
            );
      }
      const snapshot = yield* deps.projections.getShellSnapshot();
      const id = defaultProjectFor(snapshot.projects, snapshot.threads);
      const project = id === null ? undefined : snapshot.projects.find((entry) => entry.id === id);
      return project ?? fail(404, "no_projects", "This computer has no projects yet.");
    });

  const resolveModel = (input: ManagerRemoteChatCreateInput, project: OrchestrationProjectShell) =>
    Effect.gen(function* () {
      const provider = input.provider?.trim();
      const model = input.model?.trim();
      if (provider !== undefined && provider.length > 0) {
        const resolved = resolveProviderModelSelection({
          provider,
          model: model !== undefined && model.length > 0 ? model : undefined,
          providers: yield* deps.getProviders,
        });
        return resolved.ok ? resolved.selection : fail(400, "invalid_provider", resolved.message);
      }
      const base =
        project.defaultModelSelection ??
        lastUsedModel((yield* deps.projections.getShellSnapshot()).threads, project.id);
      if (base === null) {
        return fail(
          400,
          "model_required",
          'This computer has no default AI for that project — pass "provider" (e.g. "claudeAgent", "codex", "uno").',
        );
      }
      return model !== undefined && model.length > 0
        ? ({ instanceId: base.instanceId, model } satisfies ModelSelection)
        : base;
    });

  const create = (input: ManagerRemoteChatCreateInput): Effect.Effect<RemoteChatHostReply> =>
    Effect.gen(function* () {
      const text = input.text.trim();
      if (text.length === 0 || text.length > MAX_TEXT_CHARS) {
        return fail(400, "invalid_payload", `"text" is 1–${MAX_TEXT_CHARS} characters.`);
      }
      const project = yield* resolveProject(input);
      if (isReply(project)) return project;
      const modelSelection = yield* resolveModel(input, project);
      if (isReply(modelSelection)) return modelSelection;
      const inherited = yield* inheritProjectThreadModes(deps.projections, project.id);
      // Never wider than the assistant that asked, nor than the project's chats.
      const runtimeMode = capRuntimeMode(
        inherited.runtimeMode,
        input.runtimeMode ?? "approval-required",
      );
      const title = (input.title?.trim() || defaultTitleFromText(text)).slice(0, MAX_TITLE_CHARS);
      const threadId = ThreadId.make(crypto.randomUUID());
      const createdAt = new Date(nowMs()).toISOString();
      const origin = systemCommandOrigin(
        REMOTE_CHAT_ORIGIN_COMPONENT,
        `${input.startedBy.assistantName} on ${input.startedBy.fromComputerName}`,
      );
      yield* deps.engine.dispatch(
        {
          type: "thread.create",
          commandId: CommandId.make(`remote-chat:create:${crypto.randomUUID()}`),
          threadId,
          projectId: project.id,
          title,
          modelSelection,
          runtimeMode,
          interactionMode: inherited.interactionMode,
          branch: null,
          worktreePath: null,
          createdAt,
        },
        { origin },
      );
      yield* deps.incoming.record({
        threadId,
        assistantName: input.startedBy.assistantName,
        assistantProjectId: input.startedBy.assistantProjectId,
        fromComputerName: input.startedBy.fromComputerName,
        fromBoxId: input.startedBy.fromBoxId,
        fromThreadId: input.startedBy.fromThreadId,
        startedAt: createdAt,
      });
      yield* deps.engine.dispatch(
        {
          type: "thread.turn.start",
          commandId: CommandId.make(`remote-chat:turn:${crypto.randomUUID()}`),
          threadId,
          message: {
            messageId: MessageId.make(crypto.randomUUID()),
            role: "user",
            text,
            attachments: [],
          },
          runtimeMode,
          interactionMode: inherited.interactionMode,
          createdAt,
        },
        { origin },
      );
      yield* Effect.logInfo("remote chat started here").pipe(
        Effect.annotateLogs({
          threadId,
          projectId: project.id,
          from: input.startedBy.fromComputerName,
          assistant: input.startedBy.assistantName,
          runtimeMode,
        }),
      );
      return {
        status: 200,
        body: { threadId, projectId: project.id, title } satisfies ManagerRemoteChatResult,
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("remote chat: start failed", { cause }).pipe(
          Effect.as(fail(500, "internal_error", "This computer couldn't start the chat.")),
        ),
      ),
    );

  const status = (rawThreadId: string): Effect.Effect<RemoteChatHostReply> =>
    Effect.gen(function* () {
      const id = rawThreadId.trim();
      const incoming = yield* deps.incoming.list;
      if (id.length === 0 || !incoming.some((entry) => entry.threadId === id)) {
        return fail(404, "thread_not_found", "No such chat started from another computer here.");
      }
      const threadId = ThreadId.make(id);
      const shell = yield* deps.projections.getThreadShellById(threadId);
      if (Option.isNone(shell)) {
        return fail(404, "thread_not_found", "That chat is gone from this computer.");
      }
      const latest = shell.value.latestTurn;
      const turns = latest === null ? [] : [latest];
      const detail = yield* deps.projections.getThreadDetailById(threadId);
      const last = Option.isSome(detail) ? lastAssistantText(detail.value.messages) : null;
      const state =
        shell.value.archivedAt !== null
          ? "stopped"
          : remoteStateWord(workStatusState(shell.value, turns));
      return {
        status: 200,
        body: {
          threadId,
          title: shell.value.title,
          state,
          lastMessage: last === null ? null : last.slice(0, REMOTE_CHAT_LAST_MESSAGE_CHARS),
          updatedAt: shell.value.updatedAt,
        } satisfies ManagerRemoteChatStatus,
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("remote chat: status failed", { cause }).pipe(
          Effect.as(fail(500, "internal_error", "This computer couldn't read the chat.")),
        ),
      ),
    );

  const startedBy = (): Effect.Effect<RemoteChatHostReply> =>
    Effect.gen(function* () {
      const snapshot = yield* deps.projections.getShellSnapshot();
      const byId = new Map(snapshot.threads.map((thread) => [thread.id as string, thread]));
      const projectTitle = new Map(snapshot.projects.map((p) => [p.id as string, p.title]));
      const ledger = yield* deps.startedChats;
      const names = new Map<string, string>();
      const nameOf = (projectId: string) =>
        Effect.gen(function* () {
          const known = names.get(projectId);
          if (known !== undefined) return known;
          const name = yield* deps.assistantName(projectId, projectTitle.get(projectId) ?? "");
          names.set(projectId, name);
          return name;
        });
      const items: Array<ManagerStartedByEntry> = [];
      for (const thread of snapshot.threads) {
        if (thread.archivedAt !== null || isAssistantConversationThread(thread)) continue;
        const owner = owningAssistant(thread, (id) => byId.get(id), ledger);
        if (owner === null) continue;
        items.push({
          threadId: thread.id,
          assistantName: yield* nameOf(owner),
          assistantProjectId: owner,
          local: true,
          fromComputerName: null,
          fromBoxId: null,
          startedAt: thread.createdAt,
        });
      }
      const listed = new Set(items.map((item) => item.threadId as string));
      for (const entry of yield* deps.incoming.list) {
        const thread = byId.get(entry.threadId);
        if (thread === undefined || thread.archivedAt !== null || listed.has(entry.threadId)) {
          continue;
        }
        items.push({
          threadId: ThreadId.make(entry.threadId),
          assistantName: entry.assistantName,
          assistantProjectId: entry.assistantProjectId,
          local: false,
          fromComputerName: entry.fromComputerName,
          fromBoxId: entry.fromBoxId,
          startedAt: entry.startedAt,
        });
      }
      items.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return { status: 200, body: { items } };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("started-by list failed", { cause }).pipe(
          Effect.as(fail(500, "internal_error", "Couldn't list the chats assistants started.")),
        ),
      ),
    );

  return { create, status, startedBy };
}

/** An assistant's name as the person sees it — the same rule as `memberName` (assistantTeam.ts). */
export const assistantDisplayName = (
  projectId: string,
  projectTitle: string,
  teamName: string | null,
): string =>
  teamName?.trim() ||
  (projectId === ASSISTANT_PROJECT_ID ? "Uno" : projectTitle.trim() || "Assistant");
