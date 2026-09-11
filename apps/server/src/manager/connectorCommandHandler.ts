/**
 * Executes connector chat commands (see `connectorCommands.ts`) against the
 * binding repository, the projection read model and the orchestration
 * engine. Every command returns the plain-text reply for the chat and never
 * fails: storage / dispatch errors become a one-line explanation.
 *
 * Dependencies are narrowed interfaces (same shape as the plugin panel
 * sender), so tests drive it with in-memory fakes.
 */
import {
  CommandId,
  isAssistantProjectId,
  type ManagerConnectorBinding,
  type ManagerConnectorBindingKind,
  type ManagerConnectorBindingTarget,
  type OrchestrationCommandOrigin,
  type OrchestrationThreadShell,
  type ProjectId,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";
import * as crypto from "node:crypto";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ManagerConnectorBindingRepositoryShape } from "../persistence/Services/ManagerConnectorBindings.ts";
import type { ProjectionPendingApprovalRepositoryShape } from "../persistence/Services/ProjectionPendingApprovals.ts";
import {
  bindingTargetLabel,
  effectiveBindingTarget,
  matchByTitleOrId,
  type BindingTargetLabels,
  type MatchResult,
} from "./connectorBindings.ts";
import {
  approvalDecisionForCommand,
  CONNECTOR_COMMANDS_HELP,
  decideApprovalAction,
  type ConnectorCommand,
  type PendingApprovalCandidate,
} from "./connectorCommands.ts";

export interface ConnectorCommandDeps {
  readonly bindings: Pick<ManagerConnectorBindingRepositoryShape, "get" | "upsert" | "remove">;
  readonly projections: Pick<ProjectionSnapshotQueryShape, "getShellSnapshot">;
  readonly pendingApprovals: Pick<ProjectionPendingApprovalRepositoryShape, "listByThreadId">;
  readonly engine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly now?: () => Date;
}

export interface ConnectorCommandContext {
  readonly kind: ManagerConnectorBindingKind;
  readonly chatId: string;
  /** Assistant project whose connector carries the chat. */
  readonly connectorProjectId: ProjectId;
  readonly origin: OrchestrationCommandOrigin;
}

const THREADS_LIST_LIMIT = 20;

const describeError = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "object" && cause !== null && "message" in cause
      ? String((cause as { message: unknown }).message)
      : String(cause);

const threadState = (thread: OrchestrationThreadShell): string =>
  thread.hasPendingApprovals
    ? "waiting for approval"
    : (thread.latestTurn?.state ?? thread.session?.status ?? "idle");

const listCandidates = (items: ReadonlyArray<{ id: string; title: string }>): string =>
  items.map((item) => `- ${item.title} [${item.id}]`).join("\n");

const describeMatchFailure = <T extends { id: string; title: string }>(
  noun: string,
  query: string,
  result: Exclude<MatchResult<T>, { kind: "match" }>,
  available: ReadonlyArray<T>,
): string =>
  result.kind === "ambiguous"
    ? `Several ${noun}s match "${query}" - be more specific:\n${listCandidates(result.candidates)}`
    : available.length === 0
      ? `No ${noun}s available.`
      : `No ${noun} matches "${query}". Available:\n${listCandidates(available.slice(0, THREADS_LIST_LIMIT))}`;

const describeBinding = (
  target: ManagerConnectorBindingTarget,
  binding: ManagerConnectorBinding | null,
  labels: BindingTargetLabels,
): string => {
  const label = bindingTargetLabel(target, labels);
  const notify = `Completion notifications: ${binding?.notifyOnComplete ? "on" : "off"}.`;
  switch (target.kind) {
    case "assistant":
      return binding === null
        ? `Bound to the assistant (default). ${notify}\n\n${CONNECTOR_COMMANDS_HELP}`
        : `Bound to assistant "${label ?? target.projectId}". ${notify}`;
    case "project":
      return label === null
        ? `Bound to project ${target.projectId}, which no longer exists. Use /use <project> or /assistant.`
        : `Bound to project "${label}" [${target.projectId}]. ${notify}`;
    case "thread":
      return label === null
        ? `Bound to thread ${target.threadId}, which no longer exists. Use /threads, /use <project> or /assistant.`
        : `Bound to thread "${label}" [${target.threadId}]. ${notify}`;
  }
};

export const executeConnectorCommand = (
  deps: ConnectorCommandDeps,
  context: ConnectorCommandContext,
  command: ConnectorCommand,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const now = () => (deps.now ?? (() => new Date()))();
    const key = { kind: context.kind, chatId: context.chatId };
    const snapshot = yield* deps.projections.getShellSnapshot();
    const labels = {
      projectTitleById: new Map(snapshot.projects.map((project) => [project.id, project.title])),
      threadTitleById: new Map(snapshot.threads.map((thread) => [thread.id, thread.title])),
    };
    const currentBinding = Option.getOrNull(yield* deps.bindings.get(key));
    const target = effectiveBindingTarget(currentBinding, context.connectorProjectId);

    const bind = (nextTarget: ManagerConnectorBindingTarget) =>
      deps.bindings.upsert({
        ...key,
        connectorProjectId: context.connectorProjectId,
        target: nextTarget,
        notifyOnComplete: currentBinding?.notifyOnComplete ?? false,
        updatedAt: now().toISOString(),
      });

    const targetProjectId = (): ProjectId | null => {
      if (target.kind !== "thread") {
        return target.projectId;
      }
      const thread = snapshot.threads.find((candidate) => candidate.id === target.threadId);
      return thread?.projectId ?? null;
    };

    switch (command.name) {
      case "use": {
        if (command.query.length === 0) {
          return `Usage: /use <project title or id>\n\n${CONNECTOR_COMMANDS_HELP}`;
        }
        const projects = snapshot.projects.filter((project) => !isAssistantProjectId(project.id));
        const result = matchByTitleOrId(projects, command.query);
        if (result.kind !== "match") {
          return describeMatchFailure("project", command.query, result, projects);
        }
        yield* bind({ kind: "project", projectId: result.item.id });
        return `This chat now talks to project "${result.item.title}". Messages start (or continue) this chat's thread there on the project's default model, in the project's own runtime mode. /assistant switches back.`;
      }
      case "thread": {
        if (command.query.length === 0) {
          return `Usage: /thread <thread id or title>\n\n${CONNECTOR_COMMANDS_HELP}`;
        }
        const threads = snapshot.threads.filter((thread) => thread.archivedAt === null);
        const result = matchByTitleOrId(threads, command.query);
        if (result.kind !== "match") {
          return describeMatchFailure("thread", command.query, result, threads);
        }
        yield* bind({ kind: "thread", threadId: result.item.id });
        const projectTitle =
          labels.projectTitleById.get(result.item.projectId) ?? result.item.projectId;
        return `This chat is now bound to thread "${result.item.title}" [${result.item.id}] in project "${projectTitle}". Messages go straight into it; its runtime mode stays as set in the app.`;
      }
      case "assistant": {
        if (currentBinding !== null) {
          yield* deps.bindings.remove(key);
        }
        return "This chat talks to the assistant again (default).";
      }
      case "where":
        return describeBinding(target, currentBinding, labels);
      case "threads": {
        const projectId = targetProjectId();
        if (projectId === null) {
          return "The bound thread no longer exists; use /use <project> or /assistant.";
        }
        const threads = snapshot.threads
          .filter((thread) => thread.projectId === projectId && thread.archivedAt === null)
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, THREADS_LIST_LIMIT);
        const projectTitle = labels.projectTitleById.get(projectId) ?? projectId;
        if (threads.length === 0) {
          return `No live threads in "${projectTitle}".`;
        }
        return [
          `Live threads in "${projectTitle}":`,
          ...threads.map((thread) => `- ${thread.title} [${thread.id}] - ${threadState(thread)}`),
        ].join("\n");
      }
      case "approve":
      case "deny": {
        const candidateThreads =
          target.kind === "thread"
            ? snapshot.threads.filter((thread) => thread.id === target.threadId)
            : target.kind === "project"
              ? snapshot.threads.filter(
                  (thread) =>
                    thread.projectId === target.projectId &&
                    thread.archivedAt === null &&
                    thread.hasPendingApprovals,
                )
              : [];
        const candidates: Array<PendingApprovalCandidate> = [];
        for (const thread of candidateThreads) {
          const rows = yield* deps.pendingApprovals.listByThreadId({ threadId: thread.id });
          candidates.push({
            threadId: thread.id,
            threadTitle: thread.title,
            requestIds: rows
              .filter((row) => row.status === "pending")
              .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
              .map((row) => row.requestId),
          });
        }
        const action = decideApprovalAction(target, candidates);
        switch (action.kind) {
          case "unsupported-target":
            return "Approvals are resolved here only for a bound project or thread. Bind one with /use or /thread first.";
          case "nothing-pending":
            return "Nothing is waiting for approval.";
          case "ambiguous":
            return [
              "Several threads are waiting for approval; bind one with /thread <id> and repeat:",
              ...action.candidates.map(
                (candidate) =>
                  `- ${candidate.threadTitle} [${candidate.threadId}] - ${candidate.requestIds.length} pending`,
              ),
            ].join("\n");
          case "respond": {
            const decision = approvalDecisionForCommand(command);
            yield* deps.engine.dispatch(
              {
                type: "thread.approval.respond",
                commandId: CommandId.make(`${context.kind}:${crypto.randomUUID()}`),
                threadId: action.threadId,
                requestId: action.requestId,
                decision,
                createdAt: now().toISOString(),
              },
              { origin: context.origin },
            );
            return `${decision === "accept" ? "Approved" : "Declined"} the pending request in "${action.threadTitle}".`;
          }
        }
      }
    }
  }).pipe(Effect.catch((cause) => Effect.succeed(`Command failed: ${describeError(cause)}`)));
