import {
  CommandId,
  ManagerActionProposal,
  ManagerProposalId,
  ManagerProposedAction,
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
  CountApprovedTurnProposalsSinceInput,
  CountManagerProposalsSinceInput,
  CreateManagerProposalInput,
  ExpireManagerProposalsInput,
  GetManagerProposalByIdInput,
  ListManagerProposalsInput,
  ManagerActionProposalRepository,
  type ManagerActionProposalRepositoryShape,
  ResolveManagerProposalRowInput,
  SetManagerProposalResolutionCommandsInput,
} from "../Services/ManagerActionProposals.ts";

const ManagerProposalDbRow = Schema.Struct({
  proposalId: ManagerProposalId,
  tokenId: ManagerTokenId,
  action: Schema.fromJsonString(ManagerProposedAction),
  status: Schema.Literals(["pending", "approved", "denied", "expired"]),
  nonce: Schema.String,
  requestedAt: Schema.String,
  expiresAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
  resolvedBy: Schema.NullOr(Schema.String),
  resolutionCommandIds: Schema.fromJsonString(Schema.Array(CommandId)),
});

function toProposal(row: typeof ManagerProposalDbRow.Type): ManagerActionProposal {
  return {
    proposalId: row.proposalId,
    tokenId: row.tokenId,
    action: row.action,
    status: row.status,
    nonce: row.nonce,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedBy,
    resolutionCommandIds: row.resolutionCommandIds,
  };
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ManagerRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeManagerActionProposalRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createRow = SqlSchema.void({
    Request: CreateManagerProposalInput,
    execute: (input) =>
      sql`
        INSERT INTO manager_action_proposals (
          proposal_id,
          token_id,
          action_kind,
          action_json,
          status,
          nonce,
          requested_at,
          expires_at,
          resolved_at,
          resolved_by,
          resolution_command_ids_json
        )
        VALUES (
          ${input.proposalId},
          ${input.tokenId},
          ${input.action.kind},
          ${JSON.stringify(input.action)},
          ${input.status},
          ${input.nonce},
          ${input.requestedAt},
          ${input.expiresAt},
          ${input.resolvedAt},
          ${input.resolvedBy},
          ${JSON.stringify(input.resolutionCommandIds)}
        )
      `,
  });

  const getRowById = SqlSchema.findOneOption({
    Request: GetManagerProposalByIdInput,
    Result: ManagerProposalDbRow,
    execute: ({ proposalId }) =>
      sql`
        SELECT
          proposal_id AS "proposalId",
          token_id AS "tokenId",
          action_json AS "action",
          status AS "status",
          nonce AS "nonce",
          requested_at AS "requestedAt",
          expires_at AS "expiresAt",
          resolved_at AS "resolvedAt",
          resolved_by AS "resolvedBy",
          resolution_command_ids_json AS "resolutionCommandIds"
        FROM manager_action_proposals
        WHERE proposal_id = ${proposalId}
      `,
  });

  const listRows = SqlSchema.findAll({
    Request: ListManagerProposalsInput,
    Result: ManagerProposalDbRow,
    execute: ({ status, tokenId }) =>
      sql`
        SELECT
          proposal_id AS "proposalId",
          token_id AS "tokenId",
          action_json AS "action",
          status AS "status",
          nonce AS "nonce",
          requested_at AS "requestedAt",
          expires_at AS "expiresAt",
          resolved_at AS "resolvedAt",
          resolved_by AS "resolvedBy",
          resolution_command_ids_json AS "resolutionCommandIds"
        FROM manager_action_proposals
        WHERE (${status ?? null} IS NULL OR status = ${status ?? null})
          AND (${tokenId ?? null} IS NULL OR token_id = ${tokenId ?? null})
        ORDER BY requested_at DESC, proposal_id DESC
      `,
  });

  const resolveRows = SqlSchema.findAll({
    Request: ResolveManagerProposalRowInput,
    Result: Schema.Struct({ proposalId: ManagerProposalId }),
    execute: ({ proposalId, status, resolvedAt, resolvedBy }) =>
      sql`
        UPDATE manager_action_proposals
        SET status = ${status},
            resolved_at = ${resolvedAt},
            resolved_by = ${resolvedBy}
        WHERE proposal_id = ${proposalId}
          AND status = 'pending'
        RETURNING proposal_id AS "proposalId"
      `,
  });

  const setResolutionCommandsRow = SqlSchema.void({
    Request: SetManagerProposalResolutionCommandsInput,
    execute: ({ proposalId, resolutionCommandIds }) =>
      sql`
        UPDATE manager_action_proposals
        SET resolution_command_ids_json = ${JSON.stringify(resolutionCommandIds)}
        WHERE proposal_id = ${proposalId}
      `,
  });

  const expireRows = SqlSchema.findAll({
    Request: ExpireManagerProposalsInput,
    Result: Schema.Struct({ proposalId: ManagerProposalId }),
    execute: ({ now }) =>
      sql`
        UPDATE manager_action_proposals
        SET status = 'expired',
            resolved_at = ${now},
            resolved_by = 'system:ttl'
        WHERE status = 'pending'
          AND expires_at <= ${now}
        RETURNING proposal_id AS "proposalId"
      `,
  });

  const countRequestedSinceRows = SqlSchema.findAll({
    Request: CountManagerProposalsSinceInput,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: ({ tokenId, requestedAfter }) =>
      sql`
        SELECT COUNT(*) AS "count"
        FROM manager_action_proposals
        WHERE token_id = ${tokenId}
          AND requested_at > ${requestedAfter}
      `,
  });

  const countApprovedTurnsSinceRows = SqlSchema.findAll({
    Request: CountApprovedTurnProposalsSinceInput,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: ({ tokenId, resolvedAfter }) =>
      sql`
        SELECT COUNT(*) AS "count"
        FROM manager_action_proposals
        WHERE token_id = ${tokenId}
          AND status = 'approved'
          AND action_kind IN ('create-thread', 'send-turn')
          AND resolved_at > ${resolvedAfter}
      `,
  });

  const create: ManagerActionProposalRepositoryShape["create"] = (input) =>
    createRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerActionProposalRepository.create:query",
          "ManagerActionProposalRepository.create:encodeRequest",
        ),
      ),
    );

  const getById: ManagerActionProposalRepositoryShape["getById"] = (input) =>
    getRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerActionProposalRepository.getById:query",
          "ManagerActionProposalRepository.getById:decodeRow",
        ),
      ),
      Effect.map(Option.map(toProposal)),
    );

  const list: ManagerActionProposalRepositoryShape["list"] = (input) =>
    listRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerActionProposalRepository.list:query",
          "ManagerActionProposalRepository.list:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map(toProposal)),
    );

  const resolve: ManagerActionProposalRepositoryShape["resolve"] = (input) =>
    resolveRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerActionProposalRepository.resolve:query",
          "ManagerActionProposalRepository.resolve:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const setResolutionCommands: ManagerActionProposalRepositoryShape["setResolutionCommands"] = (
    input,
  ) =>
    setResolutionCommandsRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerActionProposalRepository.setResolutionCommands:query",
          "ManagerActionProposalRepository.setResolutionCommands:encodeRequest",
        ),
      ),
    );

  const expireStale: ManagerActionProposalRepositoryShape["expireStale"] = (input) =>
    expireRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerActionProposalRepository.expireStale:query",
          "ManagerActionProposalRepository.expireStale:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.proposalId)),
    );

  const countRequestedSince: ManagerActionProposalRepositoryShape["countRequestedSince"] = (
    input,
  ) =>
    countRequestedSinceRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerActionProposalRepository.countRequestedSince:query",
          "ManagerActionProposalRepository.countRequestedSince:decodeRows",
        ),
      ),
      Effect.map((rows) => rows[0]?.count ?? 0),
    );

  const countApprovedTurnsSince: ManagerActionProposalRepositoryShape["countApprovedTurnsSince"] = (
    input,
  ) =>
    countApprovedTurnsSinceRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ManagerActionProposalRepository.countApprovedTurnsSince:query",
          "ManagerActionProposalRepository.countApprovedTurnsSince:decodeRows",
        ),
      ),
      Effect.map((rows) => rows[0]?.count ?? 0),
    );

  return {
    create,
    getById,
    list,
    resolve,
    setResolutionCommands,
    expireStale,
    countRequestedSince,
    countApprovedTurnsSince,
  } satisfies ManagerActionProposalRepositoryShape;
});

export const ManagerActionProposalRepositoryLive = Layer.effect(
  ManagerActionProposalRepository,
  makeManagerActionProposalRepository,
);
