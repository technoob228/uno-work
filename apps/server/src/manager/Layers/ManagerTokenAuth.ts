import { ManagerTokenId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import * as crypto from "node:crypto";

import { ManagerCapabilityTokenRepository } from "../../persistence/Services/ManagerCapabilityTokens.ts";
import type { ManagerCaller } from "../Services/ManagerToolService.ts";
import {
  ManagerAuthError,
  ManagerTokenAuthService,
  type ManagerTokenAuthServiceShape,
} from "../Services/ManagerTokenAuth.ts";

const TOKEN_PREFIX = "uwm_";

function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

const makeManagerTokenAuthService = Effect.gen(function* () {
  const tokenRepository = yield* ManagerCapabilityTokenRepository;

  const issueToken: ManagerTokenAuthServiceShape["issueToken"] = (input) =>
    Effect.gen(function* () {
      const secret = `${TOKEN_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
      const descriptor = {
        tokenId: ManagerTokenId.make(crypto.randomUUID()),
        label: input.label,
        scopes: input.scopes,
        projectAllowlist: input.projectAllowlist,
        budget: input.budget ?? null,
        autoApprove: input.autoApprove ?? false,
        createdAt: new Date().toISOString(),
        revokedAt: null,
      };
      yield* tokenRepository.create({
        tokenId: descriptor.tokenId,
        tokenHash: hashSecret(secret),
        label: descriptor.label,
        scopes: descriptor.scopes,
        projectAllowlist: descriptor.projectAllowlist,
        budget: descriptor.budget,
        autoApprove: descriptor.autoApprove,
        createdAt: descriptor.createdAt,
      });
      yield* Effect.logInfo("manager capability token issued").pipe(
        Effect.annotateLogs({ tokenId: descriptor.tokenId, scopes: descriptor.scopes }),
      );
      return { descriptor, token: secret };
    });

  const authenticate: ManagerTokenAuthServiceShape["authenticate"] = (authorizationHeader) =>
    Effect.gen(function* () {
      const presented = authorizationHeader?.replace(/^Bearer\s+/i, "").trim() ?? "";
      if (presented.length === 0 || !presented.startsWith(TOKEN_PREFIX)) {
        return yield* new ManagerAuthError({ detail: "Missing or malformed bearer token." });
      }
      // Lookup by SHA-256 hash: the DB never sees the secret and equality on
      // the digest leaks nothing useful about it.
      const record = yield* tokenRepository.getActiveByHash({
        tokenHash: hashSecret(presented),
      });
      if (Option.isNone(record)) {
        return yield* new ManagerAuthError({ detail: "Unknown or revoked token." });
      }
      return {
        tokenId: record.value.tokenId,
        scopes: record.value.scopes,
        projectAllowlist: record.value.projectAllowlist,
        budget: record.value.budget,
        autoApprove: record.value.autoApprove,
      } satisfies ManagerCaller;
    });

  const listTokens: ManagerTokenAuthServiceShape["listTokens"] = () => tokenRepository.list();

  const revokeToken: ManagerTokenAuthServiceShape["revokeToken"] = (tokenId) =>
    tokenRepository.revoke({ tokenId, revokedAt: new Date().toISOString() });

  return {
    issueToken,
    authenticate,
    listTokens,
    revokeToken,
  } satisfies ManagerTokenAuthServiceShape;
});

export const ManagerTokenAuthServiceLive = Layer.effect(
  ManagerTokenAuthService,
  makeManagerTokenAuthService,
);
