/**
 * T3 v2 compat: our v1 thread detail (`OrchestrationThread`: messages +
 * activities + proposed plans + session) → upstream
 * `OrchestrationV2ThreadProjection`.
 *
 * The phone draws the chat from `visibleTurnItems`; `runs` give it the active
 * run for Stop, `runtimeRequests` drive the approve / answer buttons. Every
 * other projection array (nodes, subagents, checkpoints, handoffs…) is empty —
 * upstream accepts that.
 *
 * Stage 1 compromises (see SPEC «Костыли»):
 * - a tool call is the `tool.completed` activity; `tool.started` shows only
 *   while nothing later in the same turn closed it (we do not persist the
 *   provider item id that links them);
 * - reasoning text and message attachments are not sent;
 * - `nodeId` / `providerSessionId` are synthetic, stable per thread.
 */
import type { OrchestrationThread, OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  activeRunIdOf,
  deriveV2ShellStatus,
  nonEmptyOrNull,
  toV2CreationFields,
  toV2InteractionMode,
  toV2ModelSelection,
  type V2Json,
  type V2PendingRequestSummary,
  type V2RunStatus,
} from "./mapShell.ts";

/** Minimal shape of a `projection_turns` row the mapper needs. */
export interface V2TurnRow {
  readonly turnId: string | null;
  readonly pendingMessageId: string | null;
  readonly state: "pending" | "running" | "interrupted" | "completed" | "error";
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

const UPSTREAM_APPROVAL_KINDS = new Set(["command", "file-read", "file-change"]);
const MAX_FAILURE_MESSAGE = 4_096;
const FALLBACK_TITLE = "New chat";

export const syntheticNodeId = (threadId: string) => `node:${threadId}`;
export const syntheticProviderSessionId = (threadId: string) => `session:${threadId}`;
export const syntheticUserMessageId = (runId: string) => `msg:${runId}`;

function payloadOf(activity: OrchestrationThreadActivity): Record<string, unknown> {
  return activity.payload && typeof activity.payload === "object"
    ? (activity.payload as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function compareActivities(a: OrchestrationThreadActivity, b: OrchestrationThreadActivity): number {
  if (a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence) {
    return a.sequence - b.sequence;
  }
  return a.createdAt.localeCompare(b.createdAt);
}

function requestKindFromRequestType(requestType: unknown): string | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

function isStaleRequestFailure(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  return (
    normalized !== undefined &&
    (normalized.includes("stale pending") || normalized.includes("unknown pending"))
  );
}

export interface V2RuntimeRequestRecord {
  readonly id: string;
  readonly type: "approval" | "user_input";
  /** Upstream `RuntimeRequest.kind`. */
  readonly kind: string;
  readonly turnId: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly status: "pending" | "resolved";
  readonly detail?: string;
  readonly questions?: ReadonlyArray<V2Json>;
}

function toV2Questions(payload: Record<string, unknown>): ReadonlyArray<V2Json> {
  const raw = payload["questions"];
  if (!Array.isArray(raw)) return [];
  const questions: V2Json[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const q = entry as Record<string, unknown>;
    const id = stringField(q, "id");
    const question = stringField(q, "question");
    if (!id || !question) continue;
    const header = stringField(q, "header") ?? question.slice(0, 40);
    const options = Array.isArray(q["options"])
      ? (q["options"] as unknown[]).flatMap((option) => {
          if (!option || typeof option !== "object") return [];
          const o = option as Record<string, unknown>;
          const label = stringField(o, "label");
          if (!label) return [];
          return [{ label, description: stringField(o, "description") ?? label }];
        })
      : [];
    questions.push({
      id,
      header,
      question,
      options,
      multiSelect: q["multiSelect"] === true,
      // Our questions may carry a free-text field or nothing to pick from.
      allowCustomAnswer: options.length === 0 || q["input"] !== undefined,
    });
  }
  return questions;
}

/**
 * Approvals and agent questions of a thread, open and answered, from its
 * activities — the same rules as the web's derivePendingApprovals /
 * derivePendingUserInputs (apps/web/src/session-logic.ts).
 */
export function deriveRuntimeRequests(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<V2RuntimeRequestRecord> {
  const byId = new Map<string, V2RuntimeRequestRecord>();
  for (const activity of [...activities].toSorted(compareActivities)) {
    const payload = payloadOf(activity);
    const requestId = stringField(payload, "requestId");
    if (!requestId) continue;
    const detail = stringField(payload, "detail");
    switch (activity.kind) {
      case "approval.requested": {
        const requestKind =
          typeof payload["requestKind"] === "string" &&
          UPSTREAM_APPROVAL_KINDS.has(payload["requestKind"])
            ? payload["requestKind"]
            : (requestKindFromRequestType(payload["requestType"]) ?? "permission");
        byId.set(requestId, {
          id: requestId,
          type: "approval",
          kind: requestKind,
          turnId: activity.turnId,
          createdAt: activity.createdAt,
          resolvedAt: null,
          status: "pending",
          ...(detail ? { detail } : {}),
        });
        break;
      }
      case "user-input.requested": {
        const questions = toV2Questions(payload);
        if (questions.length === 0) break;
        byId.set(requestId, {
          id: requestId,
          type: "user_input",
          kind: "user_input",
          turnId: activity.turnId,
          createdAt: activity.createdAt,
          resolvedAt: null,
          status: "pending",
          questions,
        });
        break;
      }
      case "approval.resolved":
      case "user-input.resolved": {
        const existing = byId.get(requestId);
        if (existing) {
          byId.set(requestId, { ...existing, status: "resolved", resolvedAt: activity.createdAt });
        }
        break;
      }
      case "provider.approval.respond.failed":
      case "provider.user-input.respond.failed": {
        const existing = byId.get(requestId);
        if (existing && isStaleRequestFailure(detail)) {
          byId.set(requestId, { ...existing, status: "resolved", resolvedAt: activity.createdAt });
        }
        break;
      }
      default:
        break;
    }
  }
  return [...byId.values()];
}

/** The oldest open request: what the shell badge points at. */
export function firstPendingRequest(
  requests: ReadonlyArray<V2RuntimeRequestRecord>,
): V2PendingRequestSummary | null {
  const open = requests
    .filter((request) => request.status === "pending")
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  return open ? { id: open.id, kind: open.kind, createdAt: open.createdAt } : null;
}

function v2RunStatus(state: V2TurnRow["state"], waiting: boolean): V2RunStatus {
  switch (state) {
    case "pending":
      return "preparing";
    case "running":
      return waiting ? "waiting" : "running";
    case "interrupted":
      return "interrupted";
    case "completed":
      return "completed";
    case "error":
      return "failed";
  }
}

export function toV2AppThread(thread: OrchestrationThread): V2Json {
  return {
    ...toV2CreationFields(thread),
    id: thread.id,
    projectId: thread.projectId,
    title: nonEmptyOrNull(thread.title) ?? FALLBACK_TITLE,
    providerInstanceId: thread.modelSelection.instanceId,
    modelSelection: toV2ModelSelection(thread.modelSelection),
    runtimeMode: thread.runtimeMode,
    interactionMode: toV2InteractionMode(thread.interactionMode),
    branch: nonEmptyOrNull(thread.branch),
    worktreePath: nonEmptyOrNull(thread.worktreePath),
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: thread.id },
    forkedFrom: null,
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

interface PendingItem {
  readonly sortAt: string;
  readonly sortSeq: number;
  readonly item: V2Json;
}

/** Base fields of every upstream TurnItem (ordinal is set after sorting). */
function itemBase(input: {
  readonly id: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly status: string;
  readonly title: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}): V2Json {
  return {
    id: input.id,
    threadId: input.threadId,
    runId: input.runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    status: input.status,
    title: input.title,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    updatedAt: input.updatedAt,
  };
}

function toolItem(
  thread: OrchestrationThread,
  activity: OrchestrationThreadActivity,
  running: boolean,
): V2Json {
  const payload = payloadOf(activity);
  const itemType = stringField(payload, "itemType") ?? "dynamic_tool_call";
  const detail = stringField(payload, "detail");
  const title = activity.summary.replace(/ started$/, "");
  const failed = payload["status"] === "failed";
  const base = itemBase({
    id: `item:act:${activity.id}`,
    threadId: thread.id,
    runId: activity.turnId,
    status: running ? "running" : failed ? "failed" : "completed",
    title,
    startedAt: activity.createdAt,
    completedAt: running ? null : activity.createdAt,
    updatedAt: activity.createdAt,
  });
  switch (itemType) {
    case "command_execution":
      return {
        ...base,
        type: "command_execution",
        input: detail ?? title,
        ...(failed ? { outputIndicatesFailure: true } : {}),
      };
    case "file_change":
      return { ...base, type: "file_change", fileName: detail ?? title };
    case "web_search":
      return { ...base, type: "web_search", ...(detail ? { patterns: [detail] } : {}) };
    default:
      return {
        ...base,
        type: "dynamic_tool",
        toolName: nonEmptyOrNull(title),
        input: payload["data"] ?? (detail ? { detail } : null),
      };
  }
}

function planSteps(payload: Record<string, unknown>): ReadonlyArray<V2Json> {
  const raw = payload["plan"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const text = stringField(record, "step");
    if (!text) return [];
    const status =
      record["status"] === "completed"
        ? "completed"
        : record["status"] === "inProgress"
          ? "running"
          : "pending";
    return [{ id: `step-${index}`, text, status }];
  });
}

export interface V2ThreadProjectionInput {
  readonly thread: OrchestrationThread;
  /** `projection_turns` rows of the thread; latestTurn is used when absent. */
  readonly turns?: ReadonlyArray<V2TurnRow>;
}

export function toV2ThreadProjection(input: V2ThreadProjectionInput): V2Json {
  const { thread } = input;
  const activities = [...thread.activities].toSorted(compareActivities);
  const requests = deriveRuntimeRequests(activities);
  const openRequestIds = new Set(
    requests.filter((request) => request.status === "pending").map((request) => request.id),
  );
  const pending: PendingItem[] = [];
  const seqOf = (activity: OrchestrationThreadActivity) => activity.sequence ?? 0;

  // Messages.
  for (const message of thread.messages) {
    const base = itemBase({
      id: `item:msg:${message.id}`,
      threadId: thread.id,
      runId: message.turnId,
      status: message.streaming ? "running" : "completed",
      title: null,
      startedAt: message.createdAt,
      completedAt: message.streaming ? null : message.updatedAt,
      updatedAt: message.updatedAt,
    });
    if (message.role === "user") {
      pending.push({
        sortAt: message.createdAt,
        sortSeq: 0,
        item: {
          ...base,
          ...(message.sentByThreadId
            ? { createdBy: "agent", creationSource: "mcp" }
            : { createdBy: "user", creationSource: "web" }),
          type: "user_message",
          messageId: message.id,
          inputIntent: "turn_start",
          text: message.text,
          attachments: [],
        },
      });
    } else if (message.role === "assistant") {
      pending.push({
        sortAt: message.createdAt,
        sortSeq: 0,
        item: {
          ...base,
          type: "assistant_message",
          messageId: message.id,
          text: message.text,
          streaming: message.streaming,
        },
      });
    } else {
      pending.push({
        sortAt: message.createdAt,
        sortSeq: 0,
        item: { ...base, type: "system_notice", message: message.text },
      });
    }
  }

  // Activities: tools, requests, errors, the latest todo list.
  const latestPlanActivity = activities.findLast((activity) => activity.kind === "turn.plan.updated");
  activities.forEach((activity, index) => {
    const payload = payloadOf(activity);
    switch (activity.kind) {
      case "tool.completed":
        pending.push({
          sortAt: activity.createdAt,
          sortSeq: seqOf(activity),
          item: toolItem(thread, activity, false),
        });
        return;
      case "tool.started": {
        // Shown only while nothing later in this turn closed a tool of the
        // same type (no provider item id links started → completed).
        const itemType = stringField(payload, "itemType");
        const closedLater = activities
          .slice(index + 1)
          .some(
            (later) =>
              later.turnId === activity.turnId &&
              (later.kind === "tool.completed" || later.kind === "tool.updated") &&
              stringField(payloadOf(later), "itemType") === itemType,
          );
        const turnRunning =
          activity.turnId !== null && thread.latestTurn?.turnId === activity.turnId
            ? thread.latestTurn.state === "running"
            : false;
        if (!closedLater && turnRunning) {
          pending.push({
            sortAt: activity.createdAt,
            sortSeq: seqOf(activity),
            item: toolItem(thread, activity, true),
          });
        }
        return;
      }
      case "approval.requested": {
        const requestId = stringField(payload, "requestId");
        const request = requestId ? requests.find((entry) => entry.id === requestId) : undefined;
        if (!request || request.type !== "approval") return;
        const open = openRequestIds.has(request.id);
        pending.push({
          sortAt: activity.createdAt,
          sortSeq: seqOf(activity),
          item: {
            ...itemBase({
              id: `item:req:${request.id}`,
              threadId: thread.id,
              runId: activity.turnId,
              status: open ? "waiting" : "completed",
              title: activity.summary,
              startedAt: activity.createdAt,
              completedAt: request.resolvedAt,
              updatedAt: request.resolvedAt ?? activity.createdAt,
            }),
            type: "approval_request",
            requestId: request.id,
            requestKind: request.kind,
            ...(request.detail ? { prompt: request.detail } : {}),
          },
        });
        return;
      }
      case "user-input.requested": {
        const requestId = stringField(payload, "requestId");
        const request = requestId ? requests.find((entry) => entry.id === requestId) : undefined;
        if (!request || request.type !== "user_input") return;
        const open = openRequestIds.has(request.id);
        pending.push({
          sortAt: activity.createdAt,
          sortSeq: seqOf(activity),
          item: {
            ...itemBase({
              id: `item:req:${request.id}`,
              threadId: thread.id,
              runId: activity.turnId,
              status: open ? "waiting" : "completed",
              title: activity.summary,
              startedAt: activity.createdAt,
              completedAt: request.resolvedAt,
              updatedAt: request.resolvedAt ?? activity.createdAt,
            }),
            type: "user_input_request",
            requestId: request.id,
            questions: request.questions ?? [],
          },
        });
        return;
      }
      case "runtime.error": {
        const message = (stringField(payload, "message") ?? stringField(payload, "detail") ?? activity.summary)
          .trim()
          .slice(0, MAX_FAILURE_MESSAGE);
        pending.push({
          sortAt: activity.createdAt,
          sortSeq: seqOf(activity),
          item: {
            ...itemBase({
              id: `item:act:${activity.id}`,
              threadId: thread.id,
              runId: activity.turnId,
              status: "failed",
              title: null,
              startedAt: activity.createdAt,
              completedAt: activity.createdAt,
              updatedAt: activity.createdAt,
            }),
            type: "error",
            failure: {
              class: "provider_error",
              message: message.length > 0 ? message : "The agent stopped with an error.",
              code: null,
              retryable: null,
            },
          },
        });
        return;
      }
      case "turn.plan.updated": {
        if (activity !== latestPlanActivity) return;
        const steps = planSteps(payload);
        if (steps.length === 0) return;
        pending.push({
          sortAt: activity.createdAt,
          sortSeq: seqOf(activity),
          item: {
            ...itemBase({
              id: `item:act:${activity.id}`,
              threadId: thread.id,
              runId: activity.turnId,
              status: "completed",
              title: null,
              startedAt: activity.createdAt,
              completedAt: activity.createdAt,
              updatedAt: activity.createdAt,
            }),
            type: "todo_list",
            planId: `plan:${activity.id}`,
            steps,
          },
        });
        return;
      }
      default:
        return;
    }
  });

  // Proposed plans.
  for (const plan of thread.proposedPlans) {
    pending.push({
      sortAt: plan.createdAt,
      sortSeq: 0,
      item: {
        ...itemBase({
          id: `item:plan:${plan.id}`,
          threadId: thread.id,
          runId: plan.turnId,
          status: "completed",
          title: null,
          startedAt: plan.createdAt,
          completedAt: plan.updatedAt,
          updatedAt: plan.updatedAt,
        }),
        type: "proposed_plan",
        planId: plan.id,
        markdown: plan.planMarkdown,
        streaming: false,
      },
    });
  }

  const turnItems: ReadonlyArray<V2Json> = pending
    .toSorted((a, b) => a.sortAt.localeCompare(b.sortAt) || a.sortSeq - b.sortSeq)
    .map((entry, ordinal): V2Json => ({ ...entry.item, ordinal }));

  const waitingOnUser = openRequestIds.size > 0;
  const runs = toV2Runs({ thread, turns: input.turns, waitingOnUser });

  const runtimeRequests = requests.map((request) => ({
    id: request.id,
    nodeId: syntheticNodeId(thread.id),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: request.kind,
    status: request.status,
    responseCapability: {
      type: "live",
      providerSessionId: syntheticProviderSessionId(thread.id),
    },
    createdAt: request.createdAt,
    resolvedAt: request.resolvedAt,
  }));

  const updatedAt = [thread.updatedAt, ...turnItems.map((item) => String(item["updatedAt"]))]
    .toSorted()
    .at(-1) as string;

  return {
    thread: toV2AppThread(thread),
    runs,
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests,
    messages: thread.messages.map((message) => ({
      ...(message.role === "user"
        ? message.sentByThreadId
          ? { createdBy: "agent", creationSource: "mcp" }
          : { createdBy: "user", creationSource: "web" }
        : { createdBy: "agent", creationSource: "provider" }),
      id: message.id,
      threadId: thread.id,
      runId: message.turnId,
      nodeId: null,
      role: message.role,
      text: message.text,
      attachments: [],
      streaming: message.streaming,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    })),
    plans: [],
    turnItems,
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: turnItems.map((item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: thread.id,
      sourceItemId: item["id"],
      item,
    })),
    updatedAt,
  };
}

function toV2Runs(input: {
  readonly thread: OrchestrationThread;
  readonly turns: ReadonlyArray<V2TurnRow> | undefined;
  readonly waitingOnUser: boolean;
}): ReadonlyArray<V2Json> {
  const { thread } = input;
  const rows: V2TurnRow[] = (input.turns ?? []).filter((row) => row.turnId !== null);
  const latest = thread.latestTurn;
  if (latest && !rows.some((row) => row.turnId === latest.turnId)) {
    rows.push({
      turnId: latest.turnId,
      pendingMessageId: null,
      state: latest.state,
      requestedAt: latest.requestedAt,
      startedAt: latest.startedAt,
      completedAt: latest.completedAt,
    });
  }
  const activeRunId = activeRunIdOf({ session: thread.session, latestTurn: latest });
  return rows
    .toSorted((a, b) => a.requestedAt.localeCompare(b.requestedAt))
    .map((row, index) => {
      const runId = row.turnId as string;
      const userMessageId =
        row.pendingMessageId ??
        thread.messages.find((message) => message.role === "user" && message.turnId === runId)?.id ??
        syntheticUserMessageId(runId);
      const isActive = runId === activeRunId;
      return {
        id: runId,
        threadId: thread.id,
        ordinal: index + 1,
        providerInstanceId: thread.modelSelection.instanceId,
        modelSelection: toV2ModelSelection(thread.modelSelection),
        providerThreadId: null,
        userMessageId,
        rootNodeId: null,
        activeAttemptId: null,
        status: isActive
          ? input.waitingOnUser
            ? "waiting"
            : "running"
          : v2RunStatus(row.state, input.waitingOnUser),
        requestedAt: row.requestedAt,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        checkpointId: null,
        contextHandoffId: null,
      };
    });
}

/** Shell status of a thread from its full detail (used by launchThread). */
export function v2StatusOfThread(thread: OrchestrationThread): string {
  const waitingOnUser = deriveRuntimeRequests(thread.activities).some(
    (request) => request.status === "pending",
  );
  return deriveV2ShellStatus({
    session: thread.session,
    latestTurn: thread.latestTurn,
    waitingOnUser,
  });
}
