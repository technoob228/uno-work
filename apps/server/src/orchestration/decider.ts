import type {
  ModelSelection,
  OrchestrationCommand,
  OrchestrationCommandOrigin,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
} from "@t3tools/contracts";
import { Effect } from "effect";
import {
  coerceAssistantModelSelection,
  isAssistantHarnessSelection,
} from "@t3tools/shared/assistantLlm";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";

const nowIso = () => new Date().toISOString();
const defaultMetadata: Omit<OrchestrationEvent, "sequence" | "type" | "payload"> = {
  eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
  aggregateKind: "thread",
  aggregateId: "" as OrchestrationEvent["aggregateId"],
  occurredAt: nowIso(),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    ...defaultMetadata,
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

/**
 * Who may give a chat an assistant role (see ThreadAssistantRole). Never a
 * person's command: the role is set by the daemon — the assistant-chat
 * migration (assistant / system origin) and the manager's `create_thread`
 * (manager origin, `spawned`). There is at most one live assistant chat.
 */
function assistantRoleViolation(input: {
  readonly readModel: OrchestrationReadModel;
  readonly threadId: string;
  readonly role: "chat" | "spawned" | null;
  readonly origin: OrchestrationCommandOrigin | undefined;
}): string | null {
  const { origin, role } = input;
  if (origin === undefined || origin.kind === "connector" || origin.kind === "agent") {
    return `assistant_role_forbidden: Thread '${input.threadId}' assistant role is set by the daemon only.`;
  }
  if (role === "spawned") {
    return origin.kind === "manager" || origin.kind === "assistant" || origin.kind === "system"
      ? null
      : `assistant_role_forbidden: Only the assistant marks the chats it starts.`;
  }
  if (role === "chat") {
    if (origin.kind !== "assistant" && origin.kind !== "system") {
      return `assistant_role_forbidden: Only the daemon picks the assistant chat.`;
    }
    const other = input.readModel.threads.find(
      (thread) =>
        thread.id !== input.threadId &&
        thread.deletedAt === null &&
        thread.assistantRole === "chat",
    );
    if (other !== undefined) {
      return `assistant_chat_exists: Thread '${other.id}' is already the assistant chat.`;
    }
  }
  return null;
}

/**
 * The assistant chat always runs on Hermes (0.0.84): a model selection for
 * it that names another harness — a composer's stale pick, an old client —
 * is dropped, a Hermes one is normalised to carry its LLM provider. Other
 * chats keep whatever they are given.
 */
function modelSelectionForThread(
  thread: Pick<OrchestrationThread, "assistantRole">,
  modelSelection: ModelSelection | undefined,
): ModelSelection | undefined {
  if (modelSelection === undefined || thread.assistantRole !== "chat") return modelSelection;
  return isAssistantHarnessSelection(modelSelection)
    ? coerceAssistantModelSelection(modelSelection)
    : undefined;
}

/** A user message no turn has picked up within this window is a failed start
    (or stale data), not pending work. Mirrors upstream's grace window. */
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/** Approval / user-input requests the agent is still blocked on. Ported from
    upstream T3 Code's decider (without its stale-failure pruning). */
function hasOpenRequests(thread: Pick<OrchestrationThread, "activities">): boolean {
  const open = new Set<string>();
  for (const activity of thread.activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId === null) continue;
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      open.add(requestId);
    } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      open.delete(requestId);
    }
  }
  return open.size > 0;
}

/** A user message strictly newer than every timestamp on the latest turn and
    still inside the adoption grace window: work the user just asked for that
    no session has picked up yet. */
function hasQueuedTurnStart(
  thread: Pick<OrchestrationThread, "messages" | "latestTurn" | "session">,
  now: string,
): boolean {
  if (thread.session?.status === "error") return false;
  let messageAt = Number.NEGATIVE_INFINITY;
  for (const message of thread.messages) {
    if (message.role !== "user") continue;
    const parsed = Date.parse(message.createdAt);
    if (!Number.isNaN(parsed) && parsed > messageAt) messageAt = parsed;
  }
  if (!Number.isFinite(messageAt)) return false;
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs) || Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) {
    return false;
  }
  const turn = thread.latestTurn;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}

/** Activity that outranks a snooze: the decider clears the snooze in the same
    batch so the thread is back in the inbox on every client. */
function activityRaisesHand(kind: string): boolean {
  return kind === "approval.requested" || kind === "user-input.requested";
}

function unsnoozedByActivityEvent(input: {
  readonly thread: Pick<OrchestrationThread, "id" | "snoozedUntil">;
  readonly commandId: OrchestrationCommand["commandId"];
  readonly occurredAt: string;
}): PlannedOrchestrationEvent | null {
  if (input.thread.snoozedUntil == null) return null;
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: input.thread.id,
      occurredAt: input.occurredAt,
      commandId: input.commandId,
    }),
    type: "thread.unsnoozed",
    payload: {
      threadId: input.thread.id,
      reason: "activity",
      updatedAt: input.occurredAt,
    },
  };
}

/** Real activity resets ANY settle override (upstream T3 Code rule): it wakes
    an explicitly settled thread and clears a keep-active override back to
    neutral, so the thread can auto-settle again once this work goes stale. */
function unsettledByActivityEvent(input: {
  readonly thread: Pick<OrchestrationThread, "id" | "settledOverride">;
  readonly commandId: OrchestrationCommand["commandId"];
  readonly occurredAt: string;
}): PlannedOrchestrationEvent | null {
  if (input.thread.settledOverride == null) return null;
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: input.thread.id,
      occurredAt: input.occurredAt,
      commandId: input.commandId,
    }),
    type: "thread.unsettled",
    payload: {
      threadId: input.thread.id,
      reason: "activity",
      updatedAt: input.occurredAt,
    },
  };
}

/** A human writing into a thread the spawning agent drives takes control in
    the same batch, so the agent sees `human_in_control` on its next send.
    Only human-originated sends count: the UI (no origin) and connectors
    (Telegram/Slack relay a human). Manager/assistant/plugin/peer/system
    sends leave control alone. */
function isHumanOrigin(origin: OrchestrationCommandOrigin | undefined): boolean {
  return origin === undefined || origin.kind === "connector";
}

function controlChangedEvent(input: {
  readonly threadId: OrchestrationThread["id"];
  readonly controller: NonNullable<OrchestrationThread["controller"]>;
  readonly reason: "handoff" | "human-message";
  readonly commandId: OrchestrationCommand["commandId"];
  readonly occurredAt: string;
}): PlannedOrchestrationEvent {
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: input.threadId,
      occurredAt: input.occurredAt,
      commandId: input.commandId,
    }),
    type: "thread.control-changed",
    payload: {
      threadId: input.threadId,
      controller: input.controller,
      reason: input.reason,
      changedAt: input.occurredAt,
      updatedAt: input.occurredAt,
    },
  };
}

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
  origin,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
  readonly origin?: OrchestrationCommandOrigin | undefined;
}): Effect.fn.Return<ReadonlyArray<PlannedOrchestrationEvent>, OrchestrationCommandInvariantError> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
      origin,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
  origin,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  /** Who dispatched the command (engine envelope). Absent = a human in the UI. */
  readonly origin?: OrchestrationCommandOrigin | undefined;
}): Effect.fn.Return<DecideOrchestrationCommandResult, OrchestrationCommandInvariantError> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          origin,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      const spawnedByThreadId = command.spawnedByThreadId;
      if (spawnedByThreadId !== undefined) {
        // Agent parentage is proven by the dispatch origin (the bridge resolves
        // it from the caller's scoped token), never by the command body alone.
        if (origin?.kind !== "agent" || origin.threadId !== spawnedByThreadId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `spawn_origin_mismatch: Thread '${command.threadId}' claims parent '${spawnedByThreadId}' but was not dispatched by that thread's agent.`,
          });
        }
        const parent = readModel.threads.find((thread) => thread.id === spawnedByThreadId);
        if (parent === undefined || parent.deletedAt !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `parent_thread_not_found: Parent thread '${spawnedByThreadId}' does not exist.`,
          });
        }
      }
      if (command.assistantRole !== undefined) {
        const violation = assistantRoleViolation({
          readModel,
          threadId: command.threadId,
          role: command.assistantRole,
          origin,
        });
        if (violation !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: violation,
          });
        }
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          ...(spawnedByThreadId !== undefined ? { spawnedByThreadId } : {}),
          ...(command.assistantRole !== undefined ? { assistantRole: command.assistantRole } : {}),
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent: archiving an already-archived thread is a no-op success,
      // not an error. The UI can re-send archive after a stale sidebar view or
      // a reconnect replay without surfacing a hard command-invariant failure.
      if (thread.archivedAt !== null) {
        return [];
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.unarchive": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent: unarchiving a thread that is not archived is a no-op.
      if (thread.archivedAt === null) {
        return [];
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      const metaThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const metaModelSelection = modelSelectionForThread(metaThread, command.modelSelection);
      if (command.assistantRole !== undefined) {
        const violation = assistantRoleViolation({
          readModel,
          threadId: command.threadId,
          role: command.assistantRole,
          origin,
        });
        if (violation !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: violation,
          });
        }
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(metaModelSelection !== undefined ? { modelSelection: metaModelSelection } : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...(command.pinnedAt !== undefined ? { pinnedAt: command.pinnedAt } : {}),
          ...(command.assistantRole !== undefined ? { assistantRole: command.assistantRole } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      // A wake time in the past would be snoozed and woken at once. The
      // negated comparison also rejects unparseable wake times (NaN).
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt))) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' snooze wake time ${command.snoozedUntil} is not in the future.`,
        });
      }
      // Blocked-on-you work must not be snoozed away. A running session IS
      // snoozable: snooze only affects visibility, never the agent.
      if (hasOpenRequests(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' has a pending approval or input request and cannot be snoozed.`,
        });
      }
      if (hasQueuedTurnStart(thread, occurredAt)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' has a queued turn start and cannot be snoozed.`,
        });
      }
      // Re-snoozing to the SAME wake time is a duplicate (double click, raced
      // clients): keep the original timestamps so the projection is a no-op.
      const existingSnoozedAt =
        thread.snoozedUntil === command.snoozedUntil && thread.snoozedAt != null
          ? thread.snoozedAt
          : null;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: existingSnoozedAt ?? occurredAt,
          updatedAt: existingSnoozedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.unsnooze": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent: waking a thread that is not snoozed is a no-op success.
      if (thread.snoozedUntil == null) {
        return [];
      }
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unsnoozed",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.settle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // A thread whose session is coming alive or working is not done.
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is working and cannot be settled.`,
        });
      }
      // Blocked-on-you work must be answered, not parked.
      if (hasOpenRequests(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' has a pending approval or input request and cannot be settled.`,
        });
      }
      const occurredAt = nowIso();
      // Settling inside the adoption window would hide just-requested work.
      if (hasQueuedTurnStart(thread, occurredAt)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' has a queued turn start and cannot be settled.`,
        });
      }
      // Settling an already-settled thread re-emits with the original
      // settledAt/updatedAt: double clicks and bulk settles stay silent no-ops.
      const alreadySettled = thread.settledOverride === "settled" && thread.settledAt != null;
      const settledEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.settled",
        payload: {
          threadId: command.threadId,
          settledAt: alreadySettled && thread.settledAt != null ? thread.settledAt : occurredAt,
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      };
      // Settling is "I'm done with this": clear the pin and the snooze so the
      // row lands in the settled tail instead of staying pinned or shelved.
      const companionEvents: PlannedOrchestrationEvent[] = [];
      if (thread.pinnedAt != null) {
        companionEvents.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "thread.meta-updated",
          payload: {
            threadId: command.threadId,
            pinnedAt: null,
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        companionEvents.push({
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          }),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return companionEvents.length > 0 ? [settledEvent, ...companionEvents] : settledEvent;
    }

    case "thread.unsettle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission: a duplicate keeps the existing updatedAt so
      // it does not churn ordering.
      const alreadyActive = thread.settledOverride === "active";
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyActive ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.control.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.spawnedByThreadId == null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `not_agent_thread: Thread '${command.threadId}' was not spawned by an agent; there is no one to hand control to.`,
        });
      }
      if (origin?.kind === "agent") {
        if (origin.threadId !== thread.spawnedByThreadId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `not_your_thread: Thread '${command.threadId}' was not spawned by thread '${origin.threadId}'.`,
          });
        }
        if (command.controller !== "human") {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `agent_cannot_take_control: An agent may only release thread '${command.threadId}' to the human.`,
          });
        }
      }
      // Idempotent: handing control to whoever already holds it is a no-op.
      if ((thread.controller ?? "human") === command.controller) {
        return [];
      }
      return controlChangedEvent({
        threadId: command.threadId,
        controller: command.controller,
        reason: "handoff",
        commandId: command.commandId,
        occurredAt: nowIso(),
      });
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = nowIso();
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const targetController = targetThread.controller ?? "human";
      if (origin?.kind === "agent") {
        // Any agent may message any other thread (plan 22) — its own child or a
        // peer. What it may not do is write into an agent thread a human took
        // over. Project scope and "waiting for the human" are the bridge's
        // checks (they need settings); the bridge maps these prefixes to 4xx.
        if (command.threadId === origin.threadId) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `cannot_message_self: Thread '${command.threadId}' cannot message itself.`,
          });
        }
        if (targetThread.spawnedByThreadId != null && targetController !== "agent") {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `human_in_control: A human has taken control of thread '${command.threadId}'.`,
          });
        }
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          ...(origin?.kind === "agent" ? { sentByThreadId: origin.threadId } : {}),
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(modelSelectionForThread(targetThread, command.modelSelection) !== undefined
            ? { modelSelection: modelSelectionForThread(targetThread, command.modelSelection) }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      // Sending a message to a snoozed thread is the user re-engaging: the
      // snooze is spent.
      const wakeEvent = unsnoozedByActivityEvent({
        thread: targetThread,
        commandId: command.commandId,
        occurredAt: command.createdAt,
      });
      // A human writing into an agent-driven thread takes control first, so
      // the message lands in a human-controlled thread.
      const takeControlEvent =
        targetController === "agent" && isHumanOrigin(origin)
          ? controlChangedEvent({
              threadId: command.threadId,
              controller: "human",
              reason: "human-message",
              commandId: command.commandId,
              occurredAt: command.createdAt,
            })
          : null;
      // A new turn is real activity: it resets any settle override.
      const unsettleEvent = unsettledByActivityEvent({
        thread: targetThread,
        commandId: command.commandId,
        occurredAt: command.createdAt,
      });
      return [
        ...(unsettleEvent === null ? [] : [unsettleEvent]),
        ...(wakeEvent === null ? [] : [wakeEvent]),
        ...(takeControlEvent === null ? [] : [takeControlEvent]),
        userMessageEvent,
        turnStartRequestedEvent,
      ];
    }

    case "thread.turn.interrupt": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const sessionThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sessionSetEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
      // Only a session coming alive is activity worth waking a settled thread
      // for; ready/stopped/error writes arrive after the fact and must not
      // fight an explicit settle.
      const isSessionActivity =
        command.session.status === "starting" || command.session.status === "running";
      const unsettleEvent = isSessionActivity
        ? unsettledByActivityEvent({
            thread: sessionThread,
            commandId: command.commandId,
            occurredAt: command.createdAt,
          })
        : null;
      return unsettleEvent === null ? sessionSetEvent : [unsettleEvent, sessionSetEvent];
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.message.user.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "user",
          text: command.text,
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      const activityThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      const activityEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
      // The agent asking for approval / input outranks the user's snooze.
      const wakeEvent = activityRaisesHand(command.activity.kind)
        ? unsnoozedByActivityEvent({
            thread: activityThread,
            commandId: command.commandId,
            occurredAt: command.createdAt,
          })
        : null;
      // Blocked-on-you work must never stay hidden in the settled tail.
      const unsettleEvent = activityRaisesHand(command.activity.kind)
        ? unsettledByActivityEvent({
            thread: activityThread,
            commandId: command.commandId,
            occurredAt: command.createdAt,
          })
        : null;
      if (unsettleEvent === null && wakeEvent === null) return activityEvent;
      return [
        ...(unsettleEvent === null ? [] : [unsettleEvent]),
        ...(wakeEvent === null ? [] : [wakeEvent]),
        activityEvent,
      ];
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
