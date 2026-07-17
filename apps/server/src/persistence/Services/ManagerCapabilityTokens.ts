/**
 * ManagerCapabilityTokenRepository - Repository interface for manager
 * capability tokens.
 *
 * Tokens authenticate the manager brain (Hermes sidecar or native driver) on
 * the `/api/manager/*` surface. Only the SHA-256 hash of the bearer secret is
 * persisted; the plaintext is shown once at creation.
 *
 * @module ManagerCapabilityTokenRepository
 */
import {
  ManagerCapabilityTokenDescriptor,
  ManagerProjectAllowlist,
  ManagerScope,
  ManagerTokenBudget,
  ManagerTokenId,
} from "@t3tools/contracts";
import { Option, Schema, Context } from "effect";
import type { Effect } from "effect";

import type { ManagerRepositoryError } from "../Errors.ts";

export const CreateManagerTokenRecordInput = Schema.Struct({
  tokenId: ManagerTokenId,
  tokenHash: Schema.String,
  label: Schema.String,
  scopes: Schema.Array(ManagerScope),
  projectAllowlist: ManagerProjectAllowlist,
  budget: Schema.NullOr(ManagerTokenBudget),
  autoApprove: Schema.Boolean,
  createdAt: Schema.String,
});
export type CreateManagerTokenRecordInput = typeof CreateManagerTokenRecordInput.Type;

export const UpdateManagerTokenAccessInput = Schema.Struct({
  tokenId: ManagerTokenId,
  scopes: Schema.Array(ManagerScope),
  projectAllowlist: ManagerProjectAllowlist,
  autoApprove: Schema.Boolean,
});
export type UpdateManagerTokenAccessInput = typeof UpdateManagerTokenAccessInput.Type;

export const GetManagerTokenByHashInput = Schema.Struct({
  tokenHash: Schema.String,
});
export type GetManagerTokenByHashInput = typeof GetManagerTokenByHashInput.Type;

export const RevokeManagerTokenInput = Schema.Struct({
  tokenId: ManagerTokenId,
  revokedAt: Schema.String,
});
export type RevokeManagerTokenInput = typeof RevokeManagerTokenInput.Type;

export interface ManagerCapabilityTokenRepositoryShape {
  readonly create: (
    input: CreateManagerTokenRecordInput,
  ) => Effect.Effect<void, ManagerRepositoryError>;
  /** Resolve an active (non-revoked) token by bearer-secret hash. */
  readonly getActiveByHash: (
    input: GetManagerTokenByHashInput,
  ) => Effect.Effect<Option.Option<ManagerCapabilityTokenDescriptor>, ManagerRepositoryError>;
  readonly list: () => Effect.Effect<
    ReadonlyArray<ManagerCapabilityTokenDescriptor>,
    ManagerRepositoryError
  >;
  /** Latest active token with the given label (used for the in-app assistant). */
  readonly getActiveByLabel: (
    label: string,
  ) => Effect.Effect<Option.Option<ManagerCapabilityTokenDescriptor>, ManagerRepositoryError>;
  readonly updateAccess: (
    input: UpdateManagerTokenAccessInput,
  ) => Effect.Effect<boolean, ManagerRepositoryError>;
  readonly revoke: (
    input: RevokeManagerTokenInput,
  ) => Effect.Effect<boolean, ManagerRepositoryError>;
}

export class ManagerCapabilityTokenRepository extends Context.Service<
  ManagerCapabilityTokenRepository,
  ManagerCapabilityTokenRepositoryShape
>()("t3/persistence/Services/ManagerCapabilityTokens/ManagerCapabilityTokenRepository") {}
