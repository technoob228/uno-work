/**
 * T3 v2 compat: our v1 shell projections → upstream T3 v2 shapes
 * (`OrchestrationV2ThreadShell`, `OrchestrationProjectShell`,
 * `OrchestrationV2ShellSnapshot` in upstream packages/contracts/src/
 * orchestrationV2.ts).
 *
 * Pure functions over plain JSON. We deliberately do not import upstream's
 * schemas (effect 4.0.5 vs our beta.59): the contract smoke
 * (apps/server/scripts/mobile-compat/v2-contract-smoke.ts) decodes every
 * frame with the real upstream decoders and is the source of truth for shape.
 *
 * Rules that keep the phone's decoders happy:
 * - literal unions without slack upstream: `interactionMode` only
 *   default|plan (our `image` → default), `runtimeMode` adds `auto` (we never
 *   emit it);
 * - non-empty strings where upstream uses TrimmedNonEmptyString;
 * - every DateTimeUtc is an ISO string.
 */
import type {
  ModelSelection,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ProviderInteractionMode,
} from "@t3tools/contracts";

export type V2Json = Record<string, unknown>;

export const V2_SHELL_SCHEMA_VERSION = 1;

export type V2RunStatus =
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "rolled_back";

export type V2ShellThreadStatus = "idle" | V2RunStatus;

/** Summary of the request the thread waits on (shell badge «waiting for you»). */
export interface V2PendingRequestSummary {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: string;
}

export function toV2InteractionMode(mode: ProviderInteractionMode | undefined): "default" | "plan" {
  return mode === "plan" ? "plan" : "default";
}

/** Upstream's ModelSelection wire form without our option bag: options are
 *  ours (reasoning effort etc.) and the phone does not change the model in
 *  stage 1, so we do not risk its decoder on them. */
export function toV2ModelSelection(selection: ModelSelection): V2Json {
  return { instanceId: selection.instanceId, model: selection.model };
}

export function nonEmptyOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Who started the chat, in upstream's vocabulary. Agent-spawned chats and
 *  assistant chats are shown like any other chat (Misha 29.10: «все чаты, как
 *  в Work»), only labelled as agent-made. */
export function toV2CreationFields(thread: {
  readonly spawnedByThreadId?: string | null | undefined;
  readonly assistantRole?: unknown;
}): { readonly createdBy: "user" | "agent"; readonly creationSource: "web" | "mcp" | "server" } {
  if (thread.spawnedByThreadId) return { createdBy: "agent", creationSource: "mcp" };
  if (thread.assistantRole) return { createdBy: "agent", creationSource: "server" };
  return { createdBy: "user", creationSource: "web" };
}

/**
 * Thread status for the shell: the latest run's status, `waiting` while the
 * agent waits on the person, `idle` before the first message.
 */
export function deriveV2ShellStatus(input: {
  readonly session: OrchestrationThreadShell["session"];
  readonly latestTurn: OrchestrationThreadShell["latestTurn"];
  readonly waitingOnUser: boolean;
}): V2ShellThreadStatus {
  const sessionStatus = input.session?.status;
  const turn = input.latestTurn;
  const working =
    sessionStatus === "running" || sessionStatus === "starting" || turn?.state === "running";
  if (input.waitingOnUser && working) return "waiting";
  if (sessionStatus === "starting" && turn?.state !== "running") return "starting";
  if (working) return "running";
  if (input.waitingOnUser) return "waiting";
  if (!turn) return "idle";
  switch (turn.state) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "error":
      return "failed";
    default:
      return "running";
  }
}

export function activeRunIdOf(input: {
  readonly session: OrchestrationThreadShell["session"];
  readonly latestTurn: OrchestrationThreadShell["latestTurn"];
}): string | null {
  const turn = input.latestTurn;
  if (input.session?.status === "running" && input.session.activeTurnId) {
    return input.session.activeTurnId;
  }
  return turn?.state === "running" ? turn.turnId : null;
}

export function toV2ProjectShell(project: OrchestrationProjectShell): V2Json {
  return {
    id: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    defaultModelSelection: project.defaultModelSelection
      ? toV2ModelSelection(project.defaultModelSelection)
      : null,
    // Our scripts carry fewer fields and other icon literals; the phone only
    // runs them from the desktop-like project screen. Not in stage 1.
    scripts: [],
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export interface V2ShellThreadExtras {
  /** The pending request the thread waits on, when the shell knows one. */
  readonly pendingRuntimeRequest?: V2PendingRequestSummary | null;
}

export function toV2ThreadShell(
  thread: OrchestrationThreadShell,
  extras: V2ShellThreadExtras = {},
): V2Json {
  const waitingOnUser = thread.hasPendingApprovals || thread.hasPendingUserInput;
  const status = deriveV2ShellStatus({
    session: thread.session,
    latestTurn: thread.latestTurn,
    waitingOnUser,
  });
  return {
    ...toV2CreationFields(thread),
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    providerInstanceId: thread.modelSelection.instanceId,
    modelSelection: toV2ModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: toV2InteractionMode(thread.interactionMode),
    branch: nonEmptyOrNull(thread.branch),
    worktreePath: nonEmptyOrNull(thread.worktreePath),
    // Flat list: agent-spawned chats are top-level rows, not subagents, so
    // the phone shows them like Work does.
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: thread.id },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRunId: thread.latestTurn?.turnId ?? null,
    latestRunRequestedAt: thread.latestTurn?.requestedAt ?? null,
    latestRunStartedAt: thread.latestTurn?.startedAt ?? null,
    latestRunCompletedAt: thread.latestTurn?.completedAt ?? null,
    activeRunId: activeRunIdOf(thread),
    status,
    lastError: thread.session?.lastError ?? null,
    pendingRuntimeRequest: extras.pendingRuntimeRequest ?? null,
    // Not in our shell projection (would need a per-thread message read).
    latestVisibleMessage: null,
    latestUserMessageAt: thread.latestUserMessageAt,
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    // Exact counts would need a per-thread read; the phone uses them only to
    // tell an empty chat from one with history.
    itemCount: thread.latestTurn ? 1 : 0,
    visibleItemCount: thread.latestTurn ? 1 : 0,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt ?? null,
    settledOverride: thread.settledOverride ?? null,
    settledAt: thread.settledAt ?? null,
    snoozedUntil: thread.snoozedUntil ?? null,
    snoozedAt: thread.snoozedAt ?? null,
    pinnedAt: thread.pinnedAt ?? null,
    lastVisitedAt: thread.lastVisitedAt ?? null,
    deletedAt: null,
  };
}

/** Which list the phone keeps the row in. */
export function v2ShellLocation(thread: {
  readonly archivedAt?: string | null;
}): "active" | "archive" {
  return thread.archivedAt ? "archive" : "active";
}

export function toV2ShellSnapshot(input: {
  readonly snapshotSequence: number;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly pendingByThreadId?: ReadonlyMap<string, V2PendingRequestSummary>;
}): V2Json {
  const active: V2Json[] = [];
  const archived: V2Json[] = [];
  for (const thread of input.threads) {
    const row = toV2ThreadShell(thread, {
      pendingRuntimeRequest: input.pendingByThreadId?.get(thread.id) ?? null,
    });
    (v2ShellLocation(thread) === "archive" ? archived : active).push(row);
  }
  return {
    schemaVersion: V2_SHELL_SCHEMA_VERSION,
    snapshotSequence: input.snapshotSequence,
    projects: input.projects.map(toV2ProjectShell),
    threads: active,
    archivedThreads: archived,
  };
}
