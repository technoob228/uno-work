import { DEFAULT_MANAGER_TOKEN_BUDGET } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ManagerActionProposalRepository } from "../../persistence/Services/ManagerActionProposals.ts";
import { ManagerBudgetExceededError } from "../Errors.ts";
import {
  ManagerBudgetService,
  type ManagerBudgetServiceShape,
} from "../Services/ManagerBudgetService.ts";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

const TURN_STARTING_KINDS: ReadonlySet<string> = new Set(["create-thread", "send-turn"]);

const makeManagerBudgetService = Effect.gen(function* () {
  const proposalRepository = yield* ManagerActionProposalRepository;

  const checkWriteBudget: ManagerBudgetServiceShape["checkWriteBudget"] = (caller, actionKind) =>
    Effect.gen(function* () {
      const budget = caller.budget ?? DEFAULT_MANAGER_TOKEN_BUDGET;
      const nowMs = Date.now();

      const requestedLastHour = yield* proposalRepository.countRequestedSince({
        tokenId: caller.tokenId,
        requestedAfter: new Date(nowMs - HOUR_MS).toISOString(),
      });
      if (requestedLastHour >= budget.maxWriteActionsPerHour) {
        return yield* new ManagerBudgetExceededError({
          budgetKind: "write-actions-per-hour",
          limit: budget.maxWriteActionsPerHour,
        });
      }

      if (TURN_STARTING_KINDS.has(actionKind)) {
        const approvedTurnsLastDay = yield* proposalRepository.countApprovedTurnsSince({
          tokenId: caller.tokenId,
          resolvedAfter: new Date(nowMs - DAY_MS).toISOString(),
        });
        if (approvedTurnsLastDay >= budget.maxTurnsPerDay) {
          return yield* new ManagerBudgetExceededError({
            budgetKind: "turns-per-day",
            limit: budget.maxTurnsPerDay,
          });
        }
      }
    });

  return { checkWriteBudget } satisfies ManagerBudgetServiceShape;
});

export const ManagerBudgetServiceLive = Layer.effect(ManagerBudgetService, makeManagerBudgetService);
