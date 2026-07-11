/**
 * Typed errors for the manager tool layer.
 *
 * These cross the MCP boundary as tool errors, so messages must be safe to
 * show to the (untrusted) manager brain: no secrets, no internal paths.
 */
import { Schema } from "effect";

import type { ManagerRepositoryError, ProjectionRepositoryError } from "../persistence/Errors.ts";

export class ManagerScopeDeniedError extends Schema.TaggedErrorClass<ManagerScopeDeniedError>()(
  "ManagerScopeDeniedError",
  {
    requiredScope: Schema.String,
  },
) {
  override get message(): string {
    return `Capability token lacks required scope: ${this.requiredScope}.`;
  }
}

export class ManagerProjectNotAllowedError extends Schema.TaggedErrorClass<ManagerProjectNotAllowedError>()(
  "ManagerProjectNotAllowedError",
  {
    projectId: Schema.String,
  },
) {
  override get message(): string {
    return `Project ${this.projectId} is outside this token's allowlist.`;
  }
}

export class ManagerNotFoundError extends Schema.TaggedErrorClass<ManagerNotFoundError>()(
  "ManagerNotFoundError",
  {
    entity: Schema.Literals(["project", "thread", "proposal", "reminder"]),
    id: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown ${this.entity}: ${this.id}.`;
  }
}

export class ManagerInvalidRequestError extends Schema.TaggedErrorClass<ManagerInvalidRequestError>()(
  "ManagerInvalidRequestError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ManagerBudgetExceededError extends Schema.TaggedErrorClass<ManagerBudgetExceededError>()(
  "ManagerBudgetExceededError",
  {
    budgetKind: Schema.Literals(["write-actions-per-hour", "turns-per-day"]),
    limit: Schema.Number,
  },
) {
  override get message(): string {
    return `Manager budget exhausted (${this.budgetKind}, limit ${this.limit}). Ask the owner to raise the budget or wait for the window to pass.`;
  }
}

export class ManagerProposalResolutionError extends Schema.TaggedErrorClass<ManagerProposalResolutionError>()(
  "ManagerProposalResolutionError",
  {
    proposalId: Schema.String,
    reason: Schema.Literals(["already-resolved", "expired", "invalid-nonce"]),
  },
) {
  override get message(): string {
    return `Proposal ${this.proposalId} cannot be resolved: ${this.reason}.`;
  }
}

export class ManagerExecutionError extends Schema.TaggedErrorClass<ManagerExecutionError>()(
  "ManagerExecutionError",
  {
    proposalId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to execute approved proposal ${this.proposalId}: ${this.detail}`;
  }
}

export type ManagerToolError =
  | ManagerScopeDeniedError
  | ManagerProjectNotAllowedError
  | ManagerNotFoundError
  | ManagerInvalidRequestError
  | ManagerBudgetExceededError
  | ManagerProposalResolutionError
  | ManagerExecutionError
  | ManagerRepositoryError
  | ProjectionRepositoryError;
