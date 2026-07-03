import {
  ManagerCapabilityTokenDescriptor,
  ManagerProjectAllowlist,
  ManagerScope,
  ManagerTokenBudget,
  ManagerTokenId,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ManagerRepositoryError,
} from "../Errors.ts";
import {
  CreateManagerTokenRecordInput,
  GetManagerTokenByHashInput,
  ManagerCapabilityTokenRepository,
  type ManagerCapabilityTokenRepositoryShape,
  RevokeManagerTokenInput,
  UpdateManagerTokenAccessInput,
} from "../Services/ManagerCapabilityTokens.ts";

const ManagerTokenDbRow = Schema.Struct({
  tokenId: ManagerTokenId,
  label: Schema.String,
  scopes: Schema.fromJsonString(Schema.Array(ManagerScope)),
  projectAllowlist: Schema.fromJsonString(ManagerProjectAllowlist),
  budget: Schema.NullOr(Schema.fromJsonString(ManagerTokenBudget)),
  autoApprove: Schema.Number,
  createdAt: Schema.String,
  revokedAt: Schema.NullOr(Schema.String),
});

function toDescriptor(row: typeof ManagerTokenDbRow.Type): ManagerCapabilityTokenDescriptor {
  return {
    tokenId: row.tokenId,
    label: row.label,
    scopes: row.scopes,
    projectAllowlist: row.projectAllowlist,
    budget: row.budget,
    autoApprove: row.autoApprove !== 0,
    createdAt: row.createdAt,
    revokedAt: row.revokedAt,
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ManagerRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeManagerCapabilityTokenRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createRow = SqlSchema.void({
    Request: CreateManagerTokenRecordInput,
    execute: (input) =>
      sql`
        INSERT INTO manager_capability_tokens (
          token_id,
          token_hash,
          label,
          scopes_json,
          project_allowlist_json,
          budget_json,
          auto_approve,
          created_at,
          revoked_at
        )
        VALUES (
          ${input.tokenId},
          ${input.tokenHash},
          ${input.label},
          ${JSON.stringify(input.scopes)},
          ${JSON.stringify(input.projectAllowlist)},
          ${input.budget === null ? null : JSON.stringify(input.budget)},
          ${input.autoApprove ? 1 : 0},
          ${input.createdAt},
          NULL
        )
      `,
  });

  const getActiveRowByHash = SqlSchema.findOneOption({
    Request: GetManagerTokenByHashInput,
    Result: ManagerTokenDbRow,
    execute: ({ tokenHash }) =>
      sql`
        SELECT
          token_id AS "tokenId",
          label AS "label",
          scopes_json AS "scopes",
          project_allowlist_json AS "projectAllowlist",
          budget_json AS "budget",
          auto_approve AS "autoApprove",
          created_at AS "createdAt",
          revoked_at AS "revokedAt"
        FROM manager_capability_tokens
        WHERE token_hash = ${tokenHash}
          AND revoked_at IS NULL
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: ManagerTokenDbRow,
    execute: () =>
      sql`
        SELECT
          token_id AS "tokenId",
          label AS "label",
          scopes_json AS "scopes",
          project_allowlist_json AS "projectAllowlist",
          budget_json AS "budget",
          auto_approve AS "autoApprove",
          created_at AS "createdAt",
          revoked_at AS "revokedAt"
        FROM manager_capability_tokens
        ORDER BY created_at DESC, token_id DESC
      `,
  });

  const revokeRows = SqlSchema.findAll({
    Request: RevokeManagerTokenInput,
    Result: Schema.Struct({ tokenId: ManagerTokenId }),
    execute: ({ tokenId, revokedAt }) =>
      sql`
        UPDATE manager_capability_tokens
        SET revoked_at = ${revokedAt}
        WHERE token_id = ${tokenId}
          AND revoked_at IS NULL
        RETURNING token_id AS "tokenId"
      `,
  });

  const getActiveRowByLabel = SqlSchema.findOneOption({
    Request: Schema.Struct({ label: Schema.String }),
    Result: ManagerTokenDbRow,
    execute: ({ label }) =>
      sql`
        SELECT
          token_id AS "tokenId",
          label AS "label",
          scopes_json AS "scopes",
          project_allowlist_json AS "projectAllowlist",
          budget_json AS "budget",
          auto_approve AS "autoApprove",
          created_at AS "createdAt",
          revoked_at AS "revokedAt"
        FROM manager_capability_tokens
        WHERE label = ${label}
          AND revoked_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      `,
  });

  const updateAccessRows = SqlSchema.findAll({
    Request: UpdateManagerTokenAccessInput,
    Result: Schema.Struct({ tokenId: ManagerTokenId }),
    execute: ({ tokenId, scopes, projectAllowlist, autoApprove }) =>
      sql`
        UPDATE manager_capability_tokens
        SET scopes_json = ${JSON.stringify(scopes)},
            project_allowlist_json = ${JSON.stringify(projectAllowlist)},
            auto_approve = ${autoApprove ? 1 : 0}
        WHERE token_id = ${tokenId}
          AND revoked_at IS NULL
        RETURNING token_id AS "tokenId"
      `,
  });

  const create: ManagerCapabilityTokenRepositoryShape["create"] = (input) =>
    createRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerCapabilityTokenRepository.create:query",
          "ManagerCapabilityTokenRepository.create:encodeRequest",
        ),
      ),
    );

  const getActiveByHash: ManagerCapabilityTokenRepositoryShape["getActiveByHash"] = (input) =>
    getActiveRowByHash(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerCapabilityTokenRepository.getActiveByHash:query",
          "ManagerCapabilityTokenRepository.getActiveByHash:decodeRow",
        ),
      ),
      Effect.map(Option.map(toDescriptor)),
    );

  const list: ManagerCapabilityTokenRepositoryShape["list"] = () =>
    listRows({}).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerCapabilityTokenRepository.list:query",
          "ManagerCapabilityTokenRepository.list:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(toDescriptor)),
    );

  const revoke: ManagerCapabilityTokenRepositoryShape["revoke"] = (input) =>
    revokeRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerCapabilityTokenRepository.revoke:query",
          "ManagerCapabilityTokenRepository.revoke:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const getActiveByLabel: ManagerCapabilityTokenRepositoryShape["getActiveByLabel"] = (label) =>
    getActiveRowByLabel({ label }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerCapabilityTokenRepository.getActiveByLabel:query",
          "ManagerCapabilityTokenRepository.getActiveByLabel:decodeRow",
        ),
      ),
      Effect.map(Option.map(toDescriptor)),
    );

  const updateAccess: ManagerCapabilityTokenRepositoryShape["updateAccess"] = (input) =>
    updateAccessRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerCapabilityTokenRepository.updateAccess:query",
          "ManagerCapabilityTokenRepository.updateAccess:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  return {
    create,
    getActiveByHash,
    list,
    getActiveByLabel,
    updateAccess,
    revoke,
  } satisfies ManagerCapabilityTokenRepositoryShape;
});

export const ManagerCapabilityTokenRepositoryLive = Layer.effect(
  ManagerCapabilityTokenRepository,
  makeManagerCapabilityTokenRepository,
);
