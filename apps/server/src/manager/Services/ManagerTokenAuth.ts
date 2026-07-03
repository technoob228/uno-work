/**
 * ManagerTokenAuthService - Issues and authenticates manager capability
 * tokens (a credential class separate from user sessions; honored only on
 * `/api/manager/*` routes).
 *
 * @module ManagerTokenAuthService
 */
import type {
  ManagerCapabilityTokenDescriptor,
  ManagerCreateTokenInput,
  ManagerCreateTokenResult,
  ManagerTokenId,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { ManagerRepositoryError } from "../../persistence/Errors.ts";
import type { ManagerCaller } from "./ManagerToolService.ts";

export class ManagerAuthError extends Schema.TaggedErrorClass<ManagerAuthError>()(
  "ManagerAuthError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Manager authentication failed: ${this.detail}`;
  }
}

export interface ManagerTokenAuthServiceShape {
  readonly issueToken: (
    input: ManagerCreateTokenInput,
  ) => Effect.Effect<ManagerCreateTokenResult, ManagerRepositoryError>;
  /** Resolve a `Bearer <secret>` authorization header into a caller. */
  readonly authenticate: (
    authorizationHeader: string | undefined,
  ) => Effect.Effect<ManagerCaller, ManagerAuthError | ManagerRepositoryError>;
  readonly listTokens: () => Effect.Effect<
    ReadonlyArray<ManagerCapabilityTokenDescriptor>,
    ManagerRepositoryError
  >;
  readonly revokeToken: (tokenId: ManagerTokenId) => Effect.Effect<boolean, ManagerRepositoryError>;
}

export class ManagerTokenAuthService extends Context.Service<
  ManagerTokenAuthService,
  ManagerTokenAuthServiceShape
>()("t3/manager/Services/ManagerTokenAuthService") {}
