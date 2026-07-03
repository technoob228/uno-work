/**
 * ManagerBudgetService - Sliding-window action budgets per capability token.
 *
 * The loop-economics guardrail: enforced daemon-side where a prompt-injected
 * brain cannot negotiate it away. Windows are computed over the proposals
 * table (`requested_at` for write actions, `resolved_at` of approved
 * turn-starting actions for daily turns).
 *
 * @module ManagerBudgetService
 */
import type { ManagerProposedAction } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { ManagerBudgetExceededError } from "../Errors.ts";
import type { ManagerRepositoryError } from "../../persistence/Errors.ts";
import type { ManagerCaller } from "./ManagerToolService.ts";

export interface ManagerBudgetServiceShape {
  /**
   * Fail with `ManagerBudgetExceededError` when filing another proposal of
   * the given kind would exceed the caller's budget. Tokens without an
   * explicit budget fall back to `DEFAULT_MANAGER_TOKEN_BUDGET`.
   */
  readonly checkWriteBudget: (
    caller: ManagerCaller,
    actionKind: ManagerProposedAction["kind"],
  ) => Effect.Effect<void, ManagerBudgetExceededError | ManagerRepositoryError>;
}

export class ManagerBudgetService extends Context.Service<
  ManagerBudgetService,
  ManagerBudgetServiceShape
>()("t3/manager/Services/ManagerBudgetService") {}
