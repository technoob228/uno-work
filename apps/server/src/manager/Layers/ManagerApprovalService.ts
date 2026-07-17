import type {
  ManagerActionProposal,
  ManagerProposedAction,
  ModelSelection,
  OrchestrationCommandOrigin,
} from "@t3tools/contracts";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { Duration, Effect, Layer, Option, Schedule, Schema } from "effect";
import * as crypto from "node:crypto";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerActionProposalRepository } from "../../persistence/Services/ManagerActionProposals.ts";
import {
  ManagerExecutionError,
  ManagerNotFoundError,
  ManagerProposalResolutionError,
} from "../Errors.ts";
import {
  ManagerApprovalService,
  type ManagerApprovalServiceShape,
} from "../Services/ManagerApprovalService.ts";

const EXPIRY_SWEEP_INTERVAL = Duration.minutes(5);

const makeManagerApprovalService = Effect.gen(function* () {
  const proposalRepository = yield* ManagerActionProposalRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const makeCommandId = () => CommandId.make(`manager:${crypto.randomUUID()}`);

  const executeAction = (
    proposal: ManagerActionProposal,
    action: ManagerProposedAction,
  ): Effect.Effect<ReadonlyArray<CommandId>, ManagerExecutionError> =>
    Effect.gen(function* () {
      const origin: OrchestrationCommandOrigin = {
        kind: "manager",
        tokenId: proposal.tokenId,
        proposalId: proposal.proposalId,
      };
      const createdAt = new Date().toISOString();

      switch (action.kind) {
        case "create-thread": {
          const projectShell = yield* projectionSnapshotQuery.getProjectShellById(action.projectId);
          if (Option.isNone(projectShell)) {
            return yield* new ManagerExecutionError({
              proposalId: proposal.proposalId,
              detail: `Project ${action.projectId} no longer exists.`,
            });
          }
          const modelSelection: ModelSelection | null =
            action.modelSelection ?? projectShell.value.defaultModelSelection;
          if (modelSelection === null) {
            return yield* new ManagerExecutionError({
              proposalId: proposal.proposalId,
              detail:
                "No model selection: the proposal omitted one and the project has no default.",
            });
          }
          // Bootstrap expansion is a transport-layer concern (see ws.ts):
          // the engine itself expects the thread to exist, so create it with
          // an explicit command before starting the first turn.
          const createCommandId = makeCommandId();
          const turnCommandId = makeCommandId();
          const threadId = ThreadId.make(crypto.randomUUID());
          yield* orchestrationEngine.dispatch(
            {
              type: "thread.create",
              commandId: createCommandId,
              threadId,
              projectId: action.projectId,
              title: action.title,
              modelSelection,
              runtimeMode: action.runtimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            },
            { origin },
          );
          yield* orchestrationEngine.dispatch(
            {
              type: "thread.turn.start",
              commandId: turnCommandId,
              threadId,
              message: {
                messageId: MessageId.make(crypto.randomUUID()),
                role: "user",
                text: action.prompt,
                attachments: [],
              },
              runtimeMode: action.runtimeMode,
              interactionMode: "default",
              createdAt,
            },
            { origin },
          );
          return [createCommandId, turnCommandId];
        }
        case "send-turn": {
          const threadShell = yield* projectionSnapshotQuery.getThreadShellById(action.threadId);
          if (Option.isNone(threadShell)) {
            return yield* new ManagerExecutionError({
              proposalId: proposal.proposalId,
              detail: `Thread ${action.threadId} no longer exists.`,
            });
          }
          const commandId = makeCommandId();
          yield* orchestrationEngine.dispatch(
            {
              type: "thread.turn.start",
              commandId,
              threadId: action.threadId,
              message: {
                messageId: MessageId.make(crypto.randomUUID()),
                role: "user",
                text: action.prompt,
                attachments: [],
              },
              runtimeMode: threadShell.value.runtimeMode,
              interactionMode: threadShell.value.interactionMode,
              createdAt,
            },
            { origin },
          );
          return [commandId];
        }
        case "interrupt-turn": {
          const commandId = makeCommandId();
          yield* orchestrationEngine.dispatch(
            {
              type: "thread.turn.interrupt",
              commandId,
              threadId: action.threadId,
              createdAt,
            },
            { origin },
          );
          return [commandId];
        }
        case "respond-to-request": {
          const commandId = makeCommandId();
          yield* orchestrationEngine.dispatch(
            {
              type: "thread.approval.respond",
              commandId,
              threadId: action.threadId,
              requestId: action.requestId,
              decision: action.decision,
              createdAt,
            },
            { origin },
          );
          return [commandId];
        }
        default: {
          return yield* new ManagerExecutionError({
            proposalId: proposal.proposalId,
            detail: "Unknown proposed action kind.",
          });
        }
      }
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(ManagerExecutionError)(cause)
          ? cause
          : new ManagerExecutionError({
              proposalId: proposal.proposalId,
              detail: `Execution failed: ${
                (cause as { message?: string }).message ??
                (cause as { _tag?: string })._tag ??
                "unknown error"
              }`,
              cause,
            }),
      ),
    );

  const resolve: ManagerApprovalServiceShape["resolve"] = ({ proposalId, decision, resolvedBy }) =>
    Effect.gen(function* () {
      const existing = yield* proposalRepository.getById({ proposalId });
      if (Option.isNone(existing)) {
        return yield* new ManagerNotFoundError({ entity: "proposal", id: proposalId });
      }
      const proposal = existing.value;
      const nowIso = new Date().toISOString();
      if (proposal.status !== "pending") {
        return yield* new ManagerProposalResolutionError({
          proposalId,
          reason: "already-resolved",
        });
      }
      if (proposal.expiresAt <= nowIso) {
        // Sweep lazily so the caller sees a consistent "expired" state even
        // between timer runs.
        yield* proposalRepository.expireStale({ now: nowIso });
        return yield* new ManagerProposalResolutionError({ proposalId, reason: "expired" });
      }

      const transitioned = yield* proposalRepository.resolve({
        proposalId,
        status: decision,
        resolvedAt: nowIso,
        resolvedBy,
      });
      if (!transitioned) {
        return yield* new ManagerProposalResolutionError({
          proposalId,
          reason: "already-resolved",
        });
      }

      if (decision === "approved") {
        const commandIds = yield* executeAction(proposal, proposal.action);
        yield* proposalRepository.setResolutionCommands({
          proposalId,
          resolutionCommandIds: commandIds,
        });
      }

      const resolved = yield* proposalRepository.getById({ proposalId });
      if (Option.isNone(resolved)) {
        return yield* new ManagerNotFoundError({ entity: "proposal", id: proposalId });
      }
      return resolved.value;
    });

  const listAll: ManagerApprovalServiceShape["listAll"] = ({ status }) =>
    proposalRepository.list(status === undefined ? {} : { status });

  const expireStale: ManagerApprovalServiceShape["expireStale"] = () =>
    proposalRepository.expireStale({ now: new Date().toISOString() });

  const expirySweep = expireStale().pipe(
    Effect.tap((expired) =>
      expired.length > 0
        ? Effect.logInfo("expired stale manager proposals").pipe(
            Effect.annotateLogs({ proposalIds: expired }),
          )
        : Effect.void,
    ),
    Effect.catch((cause) =>
      Effect.logWarning("manager proposal expiry sweep failed").pipe(
        Effect.annotateLogs({ cause }),
      ),
    ),
  );
  yield* Effect.forkScoped(expirySweep.pipe(Effect.repeat(Schedule.spaced(EXPIRY_SWEEP_INTERVAL))));

  return {
    resolve,
    listAll,
    expireStale,
  } satisfies ManagerApprovalServiceShape;
});

export const ManagerApprovalServiceLive = Layer.effect(
  ManagerApprovalService,
  makeManagerApprovalService,
);
