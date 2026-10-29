/**
 * T3 v2 compat: upstream `OrchestrationV2Command` (orchestration.dispatchCommand
 * from the phone) → our v1 client commands.
 *
 * Stage 1 (Misha 29.10): chat, approvals / questions, stop, plus the sidebar
 * state the phone shares with Work (snooze, settle, archive, pin, read state).
 * Everything else gets a polite refusal the phone shows as an error on that
 * action only — never a dropped socket.
 *
 * The phone's payload reaches us undecoded (loose schemas in rpcGroup.ts), so
 * every field we forward is checked here first.
 */
import type {
  ClientOrchestrationCommand,
  OrchestrationThreadShell,
  ProviderApprovalDecision,
} from "@t3tools/contracts";

import type { V2RuntimeRequestRecord } from "./mapThread.ts";

export type V2CommandPlan =
  /** Dispatch these v1 commands in order; reply with the last sequence. */
  | { readonly kind: "dispatch"; readonly commands: ReadonlyArray<ClientOrchestrationCommand> }
  /** Accepted, nothing to change here (e.g. pin reorder): reply with the current sequence. */
  | { readonly kind: "noop" }
  | { readonly kind: "reject"; readonly message: string };

/** What the handler loads before translating a command of this type. */
export type V2CommandNeeds = "thread" | "requests" | "none";

export function v2CommandNeeds(type: string): V2CommandNeeds {
  switch (type) {
    case "message.dispatch":
      return "thread";
    case "runtime-request.respond":
    case "thread.user-input.dismiss":
      return "requests";
    default:
      return "none";
  }
}

export interface V2CommandContext {
  readonly now: string;
  /** Present for `message.dispatch` (null: thread not found). */
  readonly thread?: OrchestrationThreadShell | null;
  /** Present for runtime-request commands. */
  readonly requests?: ReadonlyArray<V2RuntimeRequestRecord>;
}

export const V2_REFUSAL = {
  unsupported: "Uno Work can't do this from the phone yet. Open the chat in Uno Work.",
  attachments:
    "Sending files from the phone is coming soon. Send text, or attach the file in Uno Work.",
  worktree:
    "New chats from the phone start in the project folder. Separate branches (worktrees) are coming soon.",
  busy: "The agent is still working on the previous message. Wait for the reply or press Stop, then send again.",
  modelChange: "Changing the model from the phone is coming soon. Change it in Uno Work.",
  autoSettle: "Auto-settle is set in Uno Work.",
  missingThread: "This chat is no longer on this computer.",
  missingRequest: "This question was already answered or has expired.",
  badCommand:
    "The phone sent a command Uno Work could not read. Update the T3 Code app and try again.",
} as const;

const reject = (message: string): V2CommandPlan => ({ kind: "reject", message });
const dispatch = (...commands: ClientOrchestrationCommand[]): V2CommandPlan => ({
  kind: "dispatch",
  commands,
});

type Raw = Record<string, unknown>;

function str(raw: Raw, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isWorking(thread: OrchestrationThreadShell): boolean {
  return (
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.latestTurn?.state === "running"
  );
}

function toOurDecision(decision: unknown): ProviderApprovalDecision | null {
  switch (decision) {
    case "accept":
    case "acceptForSession":
    case "decline":
    case "cancel":
      return decision;
    // Upstream's «always allow» has no persistent rule here: allow for this
    // session is the closest honest answer.
    case "acceptAlways":
      return "acceptForSession";
    default:
      return null;
  }
}

function toOurRuntimeMode(mode: unknown) {
  switch (mode) {
    case "approval-required":
    case "auto-accept-edits":
    case "full-access":
      return mode;
    // Upstream «auto» (classifier-approved) has no twin here; the phone only
    // sends it when the provider advertises it, which ours do not.
    default:
      return "full-access" as const;
  }
}

export function translateV2Command(raw: unknown, context: V2CommandContext): V2CommandPlan {
  if (!raw || typeof raw !== "object") return reject(V2_REFUSAL.badCommand);
  const command = raw as Raw;
  const type = str(command, "type");
  const commandId = str(command, "commandId");
  const threadId = str(command, "threadId");
  if (!type || !commandId) return reject(V2_REFUSAL.badCommand);
  const ids = () => {
    if (!threadId) return null;
    return { commandId, threadId } as unknown as {
      readonly commandId: ClientOrchestrationCommand["commandId"];
      readonly threadId: Extract<ClientOrchestrationCommand, { threadId: unknown }>["threadId"];
    };
  };
  const base = ids();

  switch (type) {
    // ---- sidebar state shared with Work ------------------------------------
    case "thread.visit": {
      const visitedAt = str(command, "visitedAt");
      if (!base || !visitedAt || !Number.isFinite(Date.parse(visitedAt))) {
        return reject(V2_REFUSAL.badCommand);
      }
      return dispatch({ type: "thread.visit", ...base, visitedAt });
    }
    case "thread.mark-unread":
      return base
        ? dispatch({ type: "thread.mark-unread", ...base })
        : reject(V2_REFUSAL.badCommand);
    case "thread.snooze": {
      const snoozedUntil = str(command, "snoozedUntil");
      if (!base || !snoozedUntil) return reject(V2_REFUSAL.badCommand);
      return dispatch({ type: "thread.snooze", ...base, snoozedUntil });
    }
    case "thread.unsnooze":
      return base
        ? dispatch({ type: "thread.unsnooze", ...base, reason: "user" })
        : reject(V2_REFUSAL.badCommand);
    case "thread.settle":
      return base ? dispatch({ type: "thread.settle", ...base }) : reject(V2_REFUSAL.badCommand);
    case "thread.unsettle":
      return base
        ? dispatch({ type: "thread.unsettle", ...base, reason: "user" })
        : reject(V2_REFUSAL.badCommand);
    case "thread.archive":
    case "thread.unarchive":
    case "thread.delete":
      return base ? dispatch({ type, ...base }) : reject(V2_REFUSAL.badCommand);
    case "thread.pin":
      return base
        ? dispatch({ type: "thread.meta.update", ...base, pinnedAt: context.now })
        : reject(V2_REFUSAL.badCommand);
    case "thread.unpin":
      return base
        ? dispatch({ type: "thread.meta.update", ...base, pinnedAt: null })
        : reject(V2_REFUSAL.badCommand);
    // Work orders pins and the active list by time; a manual order from the
    // phone is accepted and dropped (not advertised: threadPinReorder off).
    case "thread.pin.reorder":
    case "thread.active.reorder":
    // Auto-settle runs on Work's clients, not on the server.
    case "thread.auto-settle":
      return { kind: "noop" };
    case "thread.auto-settle.set":
      return reject(V2_REFUSAL.autoSettle);

    // ---- stop ---------------------------------------------------------------
    case "run.interrupt": {
      const runId = str(command, "runId");
      if (!base) return reject(V2_REFUSAL.badCommand);
      return dispatch({
        type: "thread.turn.interrupt",
        ...base,
        ...(runId ? { turnId: runId as never } : {}),
        createdAt: context.now,
      });
    }
    case "thread.stop":
      return base
        ? dispatch({ type: "thread.session.stop", ...base, createdAt: context.now })
        : reject(V2_REFUSAL.badCommand);

    // ---- approvals and questions -------------------------------------------
    case "runtime-request.respond":
    case "thread.user-input.dismiss": {
      const requestId = str(command, "requestId");
      if (!base || !requestId) return reject(V2_REFUSAL.badCommand);
      const request = context.requests?.find((entry) => entry.id === requestId);
      if (!request || request.status !== "pending") return reject(V2_REFUSAL.missingRequest);
      if (request.type === "approval") {
        if (type === "thread.user-input.dismiss") return reject(V2_REFUSAL.missingRequest);
        const decision = toOurDecision(command["decision"]);
        if (!decision) return reject(V2_REFUSAL.badCommand);
        return dispatch({
          type: "thread.approval.respond",
          ...base,
          requestId: requestId as never,
          decision,
          createdAt: context.now,
        });
      }
      // Dismissing a question = answering with nothing: the agent goes on
      // without an answer (Work has no separate dismiss).
      const answers =
        type === "runtime-request.respond" &&
        command["answers"] &&
        typeof command["answers"] === "object" &&
        !Array.isArray(command["answers"])
          ? (command["answers"] as Record<string, unknown>)
          : {};
      return dispatch({
        type: "thread.user-input.respond",
        ...base,
        requestId: requestId as never,
        answers,
        createdAt: context.now,
      });
    }

    // ---- writing ------------------------------------------------------------
    case "message.dispatch": {
      const messageId = str(command, "messageId");
      const text = typeof command["text"] === "string" ? command["text"] : null;
      if (!base || !messageId || text === null) return reject(V2_REFUSAL.badCommand);
      if (Array.isArray(command["attachments"]) && command["attachments"].length > 0) {
        return reject(V2_REFUSAL.attachments);
      }
      const thread = context.thread;
      if (!thread) return reject(V2_REFUSAL.missingThread);
      const mode =
        command["dispatchMode"] && typeof command["dispatchMode"] === "object"
          ? (command["dispatchMode"] as Raw)
          : { type: "start_immediately" };
      const modeType = str(mode, "type");
      if (modeType === "defer_start") {
        const strategy =
          mode["workspaceStrategy"] && typeof mode["workspaceStrategy"] === "object"
            ? str(mode["workspaceStrategy"] as Raw, "type")
            : null;
        if (strategy !== null && strategy !== "root") return reject(V2_REFUSAL.worktree);
      } else if (modeType !== "start_immediately" || isWorking(thread)) {
        // queue_after_active / steer_active / restart_active, or the agent is
        // mid-turn: Work has no server queue yet (SPEC §3, S4).
        return reject(V2_REFUSAL.busy);
      }
      const titleSeed = str(command, "titleSeed");
      return dispatch({
        type: "thread.turn.start",
        ...base,
        message: {
          messageId: messageId as never,
          role: "user",
          text,
          attachments: [],
        },
        ...(titleSeed ? { titleSeed } : {}),
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: context.now,
      });
    }
    case "thread.create": {
      const projectId = str(command, "projectId");
      const title = str(command, "title");
      const selection =
        command["modelSelection"] && typeof command["modelSelection"] === "object"
          ? (command["modelSelection"] as Raw)
          : null;
      const instanceId = selection
        ? (str(selection, "instanceId") ?? str(selection, "provider"))
        : null;
      const model = selection ? str(selection, "model") : null;
      if (!base || !projectId || !title || !instanceId || !model) {
        return reject(V2_REFUSAL.badCommand);
      }
      if (str(command, "worktreePath") !== null) return reject(V2_REFUSAL.worktree);
      return dispatch({
        type: "thread.create",
        ...base,
        projectId: projectId as never,
        title,
        modelSelection: { instanceId: instanceId as never, model },
        runtimeMode: toOurRuntimeMode(command["runtimeMode"]),
        interactionMode: command["interactionMode"] === "plan" ? "plan" : "default",
        branch: null,
        worktreePath: null,
        createdAt: context.now,
      });
    }
    case "thread.model-selection.set":
      return reject(V2_REFUSAL.modelChange);
    default:
      return reject(V2_REFUSAL.unsupported);
  }
}

export interface V2LaunchPlan {
  readonly threadId: string;
  readonly create: V2CommandPlan;
  /** First message, when the launch carries one. */
  readonly message: ClientOrchestrationCommand | null;
}

/**
 * `orchestration.launchThread` → thread.create (+ first message), project
 * root only (Misha 29.10: no worktree from the phone in stage 1).
 */
export function translateV2Launch(
  raw: unknown,
  context: { readonly now: string; readonly newId: () => string },
): V2LaunchPlan | { readonly kind: "reject"; readonly message: string } {
  if (!raw || typeof raw !== "object") return { kind: "reject", message: V2_REFUSAL.badCommand };
  const input = raw as Raw;
  const strategy =
    input["workspaceStrategy"] && typeof input["workspaceStrategy"] === "object"
      ? str(input["workspaceStrategy"] as Raw, "type")
      : "root";
  if (strategy !== "root") return { kind: "reject", message: V2_REFUSAL.worktree };
  const threadId = str(input, "threadId") ?? context.newId();
  const commandId = str(input, "commandId");
  if (!commandId) return { kind: "reject", message: V2_REFUSAL.badCommand };
  const create = translateV2Command(
    {
      ...input,
      type: "thread.create",
      threadId,
      worktreePath: null,
    },
    { now: context.now },
  );
  if (create.kind === "reject") return create;
  const initial =
    input["initialMessage"] && typeof input["initialMessage"] === "object"
      ? (input["initialMessage"] as Raw)
      : null;
  if (initial && Array.isArray(initial["attachments"]) && initial["attachments"].length > 0) {
    return { kind: "reject", message: V2_REFUSAL.attachments };
  }
  const text = initial && typeof initial["text"] === "string" ? initial["text"] : null;
  const createCommand =
    create.kind === "dispatch"
      ? (create.commands[0] as Extract<ClientOrchestrationCommand, { type: "thread.create" }>)
      : null;
  const message: ClientOrchestrationCommand | null =
    text !== null && text.trim().length > 0 && createCommand
      ? {
          type: "thread.turn.start",
          commandId: `${commandId}:message` as never,
          threadId: threadId as never,
          message: {
            messageId: (str(initial as Raw, "messageId") ?? context.newId()) as never,
            role: "user",
            text,
            attachments: [],
          },
          titleSeed: createCommand.title,
          runtimeMode: createCommand.runtimeMode,
          interactionMode: createCommand.interactionMode,
          createdAt: context.now,
        }
      : null;
  return { threadId, create, message };
}
