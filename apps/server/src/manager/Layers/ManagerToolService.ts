import type {
  ManagerActionProposal,
  ManagerPendingApprovalSummary,
  ManagerProposedAction,
  ManagerScope,
  ManagerThreadSummary,
  ManagerWaitMode,
  ManagerWaitStatus,
  ManagerWaitThreadResult,
  ManagerWriteReceipt,
  OrchestrationThreadShell,
  ProjectId,
  Reminder,
  ThreadId,
} from "@t3tools/contracts";
import {
  MANAGER_PROPOSAL_TTL_MINUTES,
  MANAGER_READ_THREAD_DETAIL_DEFAULT_MESSAGES,
  MANAGER_READ_THREAD_DETAIL_MAX_MESSAGE_CHARS,
  MANAGER_WAIT_DEFAULT_TIMEOUT_SEC,
  ManagerProposalId,
  ManagerSlackConnectorConfig,
  ManagerTelegramConnectorConfig,
  type ReminderConnectorKind,
} from "@t3tools/contracts";
import { Clock, Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import * as crypto from "node:crypto";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ManagerActionProposalRepository } from "../../persistence/Services/ManagerActionProposals.ts";
import { ManagerConnectorRepository } from "../../persistence/Services/ManagerConnectors.ts";
import { RemindersRepository } from "../../persistence/Services/Reminders.ts";
import {
  ManagerInvalidRequestError,
  ManagerNotFoundError,
  ManagerProjectNotAllowedError,
  ManagerProposalResolutionError,
  ManagerScopeDeniedError,
  type ManagerToolError,
} from "../Errors.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { ManagerApprovalService } from "../Services/ManagerApprovalService.ts";
import { wrapUntrustedContent } from "../../untrustedContent.ts";
import { ManagerBudgetService } from "../Services/ManagerBudgetService.ts";
import {
  changedFilesOf,
  clipReply,
  describePendingRequest,
  evaluateThreadWait,
  eventTouchesThreads,
  findTurnReply,
  shouldHoldForReply,
  turnDurationMs,
  WAIT_EVENT_DEBOUNCE_MS,
  WAIT_FALLBACK_POLL_MS,
  type WaitMessage,
  type ThreadWaitVerdict,
} from "../threadWait.ts";
import {
  type ManagerCaller,
  ManagerToolService,
  type ManagerToolServiceShape,
} from "../Services/ManagerToolService.ts";

function requireScope(
  caller: ManagerCaller,
  scope: ManagerScope,
): Effect.Effect<void, ManagerScopeDeniedError> {
  return caller.scopes.includes(scope)
    ? Effect.void
    : Effect.fail(new ManagerScopeDeniedError({ requiredScope: scope }));
}

function isProjectAllowed(caller: ManagerCaller, projectId: ProjectId): boolean {
  return caller.projectAllowlist === "all" || caller.projectAllowlist.includes(projectId);
}

function requireProjectAllowed(
  caller: ManagerCaller,
  projectId: ProjectId,
): Effect.Effect<void, ManagerProjectNotAllowedError> {
  return isProjectAllowed(caller, projectId)
    ? Effect.void
    : Effect.fail(new ManagerProjectNotAllowedError({ projectId }));
}

function toThreadSummary(shell: OrchestrationThreadShell): ManagerThreadSummary {
  return {
    threadId: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    runtimeMode: shell.runtimeMode,
    sessionStatus: shell.session?.status ?? null,
    latestTurn: shell.latestTurn,
    updatedAt: shell.updatedAt,
    archivedAt: shell.archivedAt,
    hasPendingApprovals: shell.hasPendingApprovals,
    hasPendingUserInput: shell.hasPendingUserInput,
  };
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

const makeManagerToolService = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const pendingApprovalRepository = yield* ProjectionPendingApprovalRepository;
  const proposalRepository = yield* ManagerActionProposalRepository;
  const budgetService = yield* ManagerBudgetService;
  const approvalService = yield* ManagerApprovalService;
  const remindersRepository = yield* RemindersRepository;
  const connectorRepository = yield* ManagerConnectorRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionTurnRepository = yield* ProjectionTurnRepository;

  const getAllowedThreadShell = (caller: ManagerCaller, threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* projectionSnapshotQuery.getThreadShellById(threadId);
      if (Option.isNone(shell)) {
        return yield* new ManagerNotFoundError({ entity: "thread", id: threadId });
      }
      yield* requireProjectAllowed(caller, shell.value.projectId);
      return shell.value;
    });

  const listPendingApprovalsForThreads = (
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ): Effect.Effect<ReadonlyArray<ManagerPendingApprovalSummary>, ProjectionRepositoryError> =>
    Effect.forEach(
      threads.filter((thread) => thread.hasPendingApprovals),
      (thread) =>
        pendingApprovalRepository.listByThreadId({ threadId: thread.id }).pipe(
          Effect.map((approvals) =>
            approvals
              .filter((approval) => approval.status === "pending")
              .map(
                (approval): ManagerPendingApprovalSummary => ({
                  threadId: approval.threadId,
                  requestId: approval.requestId,
                  createdAt: approval.createdAt,
                }),
              ),
          ),
        ),
      { concurrency: 4 },
    ).pipe(Effect.map((nested) => nested.flat()));

  const fileProposal = (
    caller: ManagerCaller,
    action: ManagerProposedAction,
  ): Effect.Effect<ManagerWriteReceipt, ManagerToolError> =>
    Effect.gen(function* () {
      yield* requireScope(caller, "threads:write");
      yield* budgetService.checkWriteBudget(caller, action.kind);

      const nowMs = Date.now();
      const proposal: ManagerActionProposal = {
        proposalId: ManagerProposalId.make(crypto.randomUUID()),
        tokenId: caller.tokenId,
        action,
        status: "pending",
        nonce: crypto.randomBytes(16).toString("hex"),
        requestedAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + MANAGER_PROPOSAL_TTL_MINUTES * 60 * 1_000).toISOString(),
        resolvedAt: null,
        resolvedBy: null,
        resolutionCommandIds: [],
      };
      yield* proposalRepository.create(proposal);
      yield* Effect.logInfo("manager proposal filed").pipe(
        Effect.annotateLogs({
          proposalId: proposal.proposalId,
          tokenId: caller.tokenId,
          actionKind: action.kind,
          autoApprove: caller.autoApprove,
        }),
      );

      // Auto-approve tier (in-app assistant): execute right away. The
      // proposal row is still written and resolved as `auto:<tokenId>`, so
      // the audit trail is identical to the manual path.
      if (caller.autoApprove && caller.scopes.includes("threads:approve")) {
        const resolved = yield* approvalService.resolve({
          proposalId: proposal.proposalId,
          decision: "approved",
          resolvedBy: `auto:${caller.tokenId}`,
        });
        return {
          status: "executed",
          proposalId: resolved.proposalId,
          commandIds: resolved.resolutionCommandIds,
        } satisfies ManagerWriteReceipt;
      }

      return {
        status: "pending-approval",
        proposalId: proposal.proposalId,
        nonce: proposal.nonce,
        expiresAt: proposal.expiresAt,
      } satisfies ManagerWriteReceipt;
    });

  const listThreads: ManagerToolServiceShape["listThreads"] = (caller, input) =>
    Effect.gen(function* () {
      yield* requireScope(caller, "threads:read");
      if (input.projectId !== undefined) {
        yield* requireProjectAllowed(caller, input.projectId);
      }
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      const allowedProjects = snapshot.projects.filter(
        (project) =>
          isProjectAllowed(caller, project.id) &&
          (input.projectId === undefined || project.id === input.projectId),
      );
      const allowedProjectIds = new Set(allowedProjects.map((project) => project.id));
      const threads = snapshot.threads.filter(
        (thread) => allowedProjectIds.has(thread.projectId) && thread.archivedAt === null,
      );
      return {
        projects: allowedProjects.map((project) => ({
          projectId: project.id,
          title: project.title,
        })),
        threads: threads.map(toThreadSummary),
      };
    });

  const getThreadStatus: ManagerToolServiceShape["getThreadStatus"] = (caller, input) =>
    Effect.gen(function* () {
      yield* requireScope(caller, "threads:read");
      const shell = yield* getAllowedThreadShell(caller, input.threadId);
      const approvals = yield* pendingApprovalRepository
        .listByThreadId({ threadId: shell.id })
        .pipe(
          Effect.map((rows) =>
            rows
              .filter((row) => row.status === "pending")
              .map(
                (row): ManagerPendingApprovalSummary => ({
                  threadId: row.threadId,
                  requestId: row.requestId,
                  createdAt: row.createdAt,
                }),
              ),
          ),
        );
      return { thread: toThreadSummary(shell), pendingApprovals: approvals };
    });

  // ---------------------------------------------------------------------
  // wait_for_thread(s): block daemon-side instead of letting the brain poll.
  // ---------------------------------------------------------------------

  type SettledProbe = {
    readonly verdict: Extract<ThreadWaitVerdict, { settled: true }>;
    readonly reply: WaitMessage | null;
    readonly pendingRequest: string | null;
    readonly pendingApprovals: ReadonlyArray<ManagerPendingApprovalSummary>;
  };

  const listPendingApprovalsOf = (threadId: ThreadId) =>
    pendingApprovalRepository.listByThreadId({ threadId }).pipe(
      Effect.map((rows) =>
        rows
          .filter((row) => row.status === "pending")
          .map(
            (row): ManagerPendingApprovalSummary => ({
              threadId: row.threadId,
              requestId: row.requestId,
              createdAt: row.createdAt,
            }),
          ),
      ),
    );

  /** One look at a thread: `null` while its turn is still in flight. */
  const probeThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* projectionSnapshotQuery.getThreadShellById(threadId);
      if (Option.isNone(shell)) {
        return {
          verdict: {
            settled: true,
            status: "error",
            turn: null,
            error: "The thread no longer exists.",
          },
          reply: null,
          pendingRequest: null,
          pendingApprovals: [],
        } satisfies SettledProbe as SettledProbe;
      }
      const turns = yield* projectionTurnRepository.listByThreadId({ threadId });
      const nowMs = yield* Clock.currentTimeMillis;
      const session = shell.value.session;
      const verdict = evaluateThreadWait({
        hasPendingApprovals: shell.value.hasPendingApprovals,
        hasPendingUserInput: shell.value.hasPendingUserInput,
        session:
          session === null
            ? null
            : {
                status: session.status,
                updatedAt: session.updatedAt,
                lastError: session.lastError,
              },
        turns,
        nowMs,
      });
      if (!verdict.settled) {
        return null;
      }
      const detail = yield* projectionSnapshotQuery.getThreadDetailById(threadId);
      const reply = Option.isSome(detail)
        ? findTurnReply(verdict.turn, detail.value.messages)
        : null;
      if (shouldHoldForReply(verdict, reply, nowMs)) {
        return null;
      }
      const needsUser = verdict.status === "needs_user";
      return {
        verdict,
        reply,
        pendingRequest:
          needsUser && Option.isSome(detail)
            ? describePendingRequest(detail.value.activities)
            : null,
        pendingApprovals: needsUser ? yield* listPendingApprovalsOf(threadId) : [],
      } satisfies SettledProbe as SettledProbe;
    });

  const toWaitResult = (
    threadId: ThreadId,
    probe: SettledProbe | null,
    unsettledStatus: Extract<ManagerWaitStatus, "timeout" | "running">,
    settledImmediately: boolean,
  ): ManagerWaitThreadResult => {
    if (probe === null) {
      return {
        threadId,
        status: unsettledStatus,
        settledImmediately: false,
        turnId: null,
        turnStartedAt: null,
        turnCompletedAt: null,
        turnDurationMs: null,
        lastAssistantMessage: null,
        lastAssistantMessageTruncated: false,
        changedFiles: null,
        changedFilesTotal: 0,
        pendingApprovals: [],
        pendingRequest: null,
        error: null,
      };
    }
    const turn = probe.verdict.turn;
    const reply = clipReply(probe.reply);
    const files = changedFilesOf(turn);
    return {
      threadId,
      status: probe.verdict.status,
      settledImmediately,
      turnId: turn?.turnId ?? null,
      turnStartedAt: turn?.startedAt ?? null,
      turnCompletedAt: turn?.completedAt ?? null,
      turnDurationMs: turnDurationMs(turn),
      lastAssistantMessage: reply.text,
      lastAssistantMessageTruncated: reply.truncated,
      changedFiles: files.files === null ? null : [...files.files],
      changedFilesTotal: files.total,
      pendingApprovals: [...probe.pendingApprovals],
      pendingRequest: probe.pendingRequest,
      error: probe.verdict.error,
    };
  };

  const waitForThreadIds = (
    caller: ManagerCaller,
    threadIds: ReadonlyArray<ThreadId>,
    mode: ManagerWaitMode,
    timeoutSec: number,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* requireScope(caller, "threads:read");
        const unique = [...new Set(threadIds)];
        for (const threadId of unique) {
          yield* getAllowedThreadShell(caller, threadId);
        }
        const startedMs = yield* Clock.currentTimeMillis;
        const deadlineMs = startedMs + timeoutSec * 1_000;

        // Wake-ups come from the orchestration event stream (what the UI
        // listens to); the fallback poll covers a missed or absent stream.
        const wake = yield* Queue.sliding<void>(1);
        const watched: ReadonlySet<string> = new Set(unique);
        yield* orchestrationEngine.streamDomainEvents.pipe(
          Stream.filter((event) => eventTouchesThreads(event, watched)),
          Stream.runForEach(() => Queue.offer(wake, undefined)),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;

        const settled = new Map<ThreadId, SettledProbe>();
        const settledImmediately = new Set<ThreadId>();
        let firstPass = true;
        let done = false;
        while (true) {
          for (const threadId of unique) {
            if (settled.has(threadId)) continue;
            const probe = yield* probeThread(threadId);
            if (probe !== null) {
              settled.set(threadId, probe);
              if (firstPass) settledImmediately.add(threadId);
            }
          }
          firstPass = false;
          done = mode === "any" ? settled.size > 0 : settled.size === unique.length;
          const nowMs = yield* Clock.currentTimeMillis;
          if (done || nowMs >= deadlineMs) break;
          yield* Effect.raceFirst(
            Queue.take(wake),
            Effect.sleep(Math.min(WAIT_FALLBACK_POLL_MS, deadlineMs - nowMs)),
          );
          // Coalesce an event burst into a single re-evaluation.
          const afterWakeMs = yield* Clock.currentTimeMillis;
          yield* Effect.sleep(
            Math.max(0, Math.min(WAIT_EVENT_DEBOUNCE_MS, deadlineMs - afterWakeMs)),
          );
          yield* Queue.clear(wake);
        }
        const endedMs = yield* Clock.currentTimeMillis;
        const unsettledStatus = done ? "running" : "timeout";
        return {
          waitedMs: Math.max(0, endedMs - startedMs),
          timedOut: !done,
          results: unique.map((threadId) =>
            toWaitResult(
              threadId,
              settled.get(threadId) ?? null,
              unsettledStatus,
              settledImmediately.has(threadId),
            ),
          ),
        };
      }),
    );

  const waitForThread: ManagerToolServiceShape["waitForThread"] = (caller, input) =>
    waitForThreadIds(
      caller,
      [input.threadId],
      "all",
      input.timeoutSec ?? MANAGER_WAIT_DEFAULT_TIMEOUT_SEC,
    ).pipe(
      Effect.map((outcome) => ({
        ...(outcome.results[0] as ManagerWaitThreadResult),
        waitedMs: outcome.waitedMs,
      })),
    );

  const waitForThreads: ManagerToolServiceShape["waitForThreads"] = (caller, input) => {
    const mode = input.mode ?? "all";
    return waitForThreadIds(
      caller,
      input.threadIds,
      mode,
      input.timeoutSec ?? MANAGER_WAIT_DEFAULT_TIMEOUT_SEC,
    ).pipe(Effect.map((outcome) => ({ mode, ...outcome })));
  };

  const readThreadDetail: ManagerToolServiceShape["readThreadDetail"] = (caller, input) =>
    Effect.gen(function* () {
      yield* requireScope(caller, "threads:read");
      const shell = yield* getAllowedThreadShell(caller, input.threadId);
      const detail = yield* projectionSnapshotQuery.getThreadDetailById(shell.id);
      if (Option.isNone(detail)) {
        return yield* new ManagerNotFoundError({ entity: "thread", id: input.threadId });
      }
      const limit = input.lastMessages ?? MANAGER_READ_THREAD_DETAIL_DEFAULT_MESSAGES;
      const allMessages = detail.value.messages;
      const selected = allMessages.slice(-limit);
      return {
        thread: toThreadSummary(shell),
        messages: selected.map((message) => {
          const truncated = message.text.length > MANAGER_READ_THREAD_DETAIL_MAX_MESSAGE_CHARS;
          const text = truncated
            ? message.text.slice(0, MANAGER_READ_THREAD_DETAIL_MAX_MESSAGE_CHARS)
            : message.text;
          return {
            role: message.role,
            // User messages are still wrapped: they may quote agent output and
            // the manager must treat the whole transcript as data.
            text: wrapUntrustedContent(text),
            createdAt: message.createdAt,
            truncated,
          };
        }),
        omittedMessageCount: Math.max(0, allMessages.length - selected.length),
      };
    });

  const listPendingApprovals: ManagerToolServiceShape["listPendingApprovals"] = (caller) =>
    Effect.gen(function* () {
      yield* requireScope(caller, "threads:read");
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      const allowedThreads = snapshot.threads.filter(
        (thread) => isProjectAllowed(caller, thread.projectId) && thread.archivedAt === null,
      );
      const approvals = yield* listPendingApprovalsForThreads(allowedThreads);
      return { approvals };
    });

  const createThread: ManagerToolServiceShape["createThread"] = (caller, input) =>
    Effect.gen(function* () {
      yield* requireProjectAllowed(caller, input.projectId);
      const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId);
      if (Option.isNone(project)) {
        return yield* new ManagerNotFoundError({ entity: "project", id: input.projectId });
      }
      // Hard v1 rule: manager-created threads default to approval-required.
      // A full-access request is representable but still lands as an explicit
      // pending proposal like every other write.
      const runtimeMode = input.runtimeMode ?? "approval-required";
      return yield* fileProposal(caller, {
        kind: "create-thread",
        projectId: input.projectId,
        title: input.title,
        prompt: input.prompt,
        modelSelection: input.modelSelection ?? null,
        runtimeMode,
      });
    });

  const sendTurn: ManagerToolServiceShape["sendTurn"] = (caller, input) =>
    Effect.gen(function* () {
      yield* getAllowedThreadShell(caller, input.threadId);
      return yield* fileProposal(caller, {
        kind: "send-turn",
        threadId: input.threadId,
        prompt: input.prompt,
      });
    });

  const interruptTurn: ManagerToolServiceShape["interruptTurn"] = (caller, input) =>
    Effect.gen(function* () {
      yield* getAllowedThreadShell(caller, input.threadId);
      return yield* fileProposal(caller, {
        kind: "interrupt-turn",
        threadId: input.threadId,
      });
    });

  const respondToRequest: ManagerToolServiceShape["respondToRequest"] = (caller, input) =>
    Effect.gen(function* () {
      yield* requireScope(caller, "threads:approve");
      yield* getAllowedThreadShell(caller, input.threadId);
      return yield* fileProposal(caller, {
        kind: "respond-to-request",
        threadId: input.threadId,
        requestId: input.requestId,
        decision: input.decision,
      });
    });

  const listProposals: ManagerToolServiceShape["listProposals"] = (caller, input) =>
    Effect.gen(function* () {
      yield* requireScope(caller, "threads:read");
      const proposals = yield* proposalRepository.list(
        input.status === undefined
          ? { tokenId: caller.tokenId }
          : { tokenId: caller.tokenId, status: input.status },
      );
      return { proposals };
    });

  const resolveProposal: ManagerToolServiceShape["resolveProposal"] = (caller, input) =>
    Effect.gen(function* () {
      yield* requireScope(caller, "threads:approve");
      const existing = yield* proposalRepository.getById({ proposalId: input.proposalId });
      if (Option.isNone(existing)) {
        return yield* new ManagerNotFoundError({ entity: "proposal", id: input.proposalId });
      }
      const proposal = existing.value;
      // The nonce is single-use by construction: it only ever resolves a
      // pending proposal, and resolution is a one-way transition.
      if (!timingSafeStringEqual(input.nonce, proposal.nonce)) {
        return yield* new ManagerProposalResolutionError({
          proposalId: input.proposalId,
          reason: "invalid-nonce",
        });
      }
      // The resolving token must itself be allowed to touch the action's
      // target project; approve scope does not bypass the allowlist.
      const action = proposal.action;
      if (action.kind === "create-thread") {
        yield* requireProjectAllowed(caller, action.projectId);
      } else {
        yield* getAllowedThreadShell(caller, action.threadId);
      }
      const resolved = yield* approvalService.resolve({
        proposalId: input.proposalId,
        decision: input.decision,
        resolvedBy: `manager-token:${caller.tokenId}`,
      });
      return { proposal: resolved };
    });

  // Pick the (projectId, chatId, connector) a reminder should be delivered
  // to. Explicit args win; otherwise fall back to the first enabled connector
  // the caller can access — Telegram first, then Slack (unless the caller
  // pinned `connector`). Reminders are self-notifications, so this stays
  // outside the proposal/approval flow — they touch no threads and no prod.
  const resolveReminderTarget = (
    caller: ManagerCaller,
    input: {
      readonly projectId?: ProjectId | undefined;
      readonly chatId?: string | undefined;
      readonly connector?: ReminderConnectorKind | undefined;
    },
  ) =>
    Effect.gen(function* () {
      if (input.projectId !== undefined && input.chatId !== undefined) {
        yield* requireProjectAllowed(caller, input.projectId);
        return {
          projectId: input.projectId,
          chatId: input.chatId,
          connector: input.connector ?? "telegram",
        };
      }
      const candidates: Array<{
        projectId: ProjectId;
        chatId: string;
        connector: ReminderConnectorKind;
      }> = [];
      if (input.connector !== "slack") {
        const telegramConnectors = yield* connectorRepository.listByKind("telegram");
        for (const record of telegramConnectors) {
          if (!isProjectAllowed(caller, record.projectId)) continue;
          if (input.projectId !== undefined && record.projectId !== input.projectId) continue;
          const decoded = Schema.decodeUnknownExit(ManagerTelegramConnectorConfig)(record.config);
          if (decoded._tag !== "Success" || !decoded.value.enabled) continue;
          const firstChat = decoded.value.allowedChatIds[0];
          if (firstChat === undefined) continue;
          candidates.push({
            projectId: record.projectId,
            chatId: firstChat,
            connector: "telegram",
          });
        }
      }
      if (input.connector !== "telegram") {
        const slackConnectors = yield* connectorRepository.listByKind("slack");
        for (const record of slackConnectors) {
          if (!isProjectAllowed(caller, record.projectId)) continue;
          if (input.projectId !== undefined && record.projectId !== input.projectId) continue;
          const decoded = Schema.decodeUnknownExit(ManagerSlackConnectorConfig)(record.config);
          if (decoded._tag !== "Success" || !decoded.value.enabled) continue;
          const firstChannel = decoded.value.allowedChannelIds[0];
          if (firstChannel === undefined) continue;
          candidates.push({
            projectId: record.projectId,
            chatId: firstChannel,
            connector: "slack",
          });
        }
      }
      const chosen = candidates[0];
      if (chosen === undefined) {
        return yield* new ManagerInvalidRequestError({
          detail:
            "No enabled Telegram or Slack connector is available to deliver the reminder. Configure a bot for a project you can access, or pass projectId and chatId explicitly.",
        });
      }
      return {
        projectId: input.projectId ?? chosen.projectId,
        chatId: input.chatId ?? chosen.chatId,
        connector: chosen.connector,
      };
    });

  const createReminder: ManagerToolServiceShape["createReminder"] = (caller, input) =>
    Effect.gen(function* () {
      yield* requireScope(caller, "threads:write");

      if (input.dueAt === undefined && input.dueInSeconds === undefined) {
        return yield* new ManagerInvalidRequestError({
          detail: "Provide either dueInSeconds (relative) or dueAt (absolute ISO time).",
        });
      }
      const nowMs = Date.now();
      const dueAt =
        input.dueAt ?? new Date(nowMs + (input.dueInSeconds ?? 0) * 1_000).toISOString();
      if (new Date(dueAt).getTime() <= nowMs) {
        return yield* new ManagerInvalidRequestError({
          detail: "dueAt is in the past; pick a future time.",
        });
      }

      const target = yield* resolveReminderTarget(caller, {
        projectId: input.projectId,
        chatId: input.chatId,
        connector: input.connector,
      });

      const reminder: Reminder = {
        reminderId: crypto.randomUUID(),
        projectId: target.projectId,
        chatId: target.chatId,
        connector: target.connector,
        message: input.message,
        dueAt,
        status: "pending",
        createdAt: new Date(nowMs).toISOString(),
        createdBy: `manager-token:${caller.tokenId}`,
        deliveredAt: null,
        failureReason: null,
      };
      yield* remindersRepository.create(reminder);
      yield* Effect.logInfo("manager reminder created").pipe(
        Effect.annotateLogs({
          reminderId: reminder.reminderId,
          tokenId: caller.tokenId,
          projectId: reminder.projectId,
          dueAt,
        }),
      );
      return { reminderId: reminder.reminderId, dueAt, chatId: reminder.chatId };
    });

  const listReminders: ManagerToolServiceShape["listReminders"] = (caller, input) =>
    Effect.gen(function* () {
      yield* requireScope(caller, "threads:read");
      const all = yield* remindersRepository.list({
        includeInactive: input.includeInactive ?? false,
      });
      return { reminders: all.filter((reminder) => isProjectAllowed(caller, reminder.projectId)) };
    });

  const cancelReminder: ManagerToolServiceShape["cancelReminder"] = (caller, input) =>
    Effect.gen(function* () {
      yield* requireScope(caller, "threads:write");
      const existing = yield* remindersRepository.getById({ reminderId: input.reminderId });
      if (Option.isNone(existing)) {
        return yield* new ManagerNotFoundError({ entity: "reminder", id: input.reminderId });
      }
      yield* requireProjectAllowed(caller, existing.value.projectId);
      const cancelled = yield* remindersRepository.cancel({ reminderId: input.reminderId });
      return { cancelled };
    });

  return {
    listThreads,
    getThreadStatus,
    waitForThread,
    waitForThreads,
    readThreadDetail,
    listPendingApprovals,
    createThread,
    sendTurn,
    interruptTurn,
    respondToRequest,
    listProposals,
    resolveProposal,
    createReminder,
    listReminders,
    cancelReminder,
  } satisfies ManagerToolServiceShape;
});

export const ManagerToolServiceLive = Layer.effect(ManagerToolService, makeManagerToolService).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
);
