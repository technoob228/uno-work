import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect, Layer, Option } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  FileSharesRepository,
  type FileShareRow,
  type FileSharesRepositoryShape,
} from "../Services/FileShares.ts";

interface FileShareDbRow {
  readonly share_id: string;
  readonly token: string;
  readonly path: string;
  readonly kind: string;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
  readonly password_hash: string | null;
  readonly access_count: number | bigint;
  readonly last_accessed_at: string | null;
}

function toRow(row: FileShareDbRow): FileShareRow {
  return {
    shareId: row.share_id,
    token: row.token,
    path: row.path,
    kind: row.kind === "folder" ? "folder" : "file",
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    passwordHash: row.password_hash,
    accessCount: Number(row.access_count),
    lastAccessedAt: row.last_accessed_at,
  };
}

/**
 * True when `candidate` is `root` or strictly inside it. Done in JS on purpose:
 * SQLite's LIKE is case-insensitive for ASCII and its substr() counts code
 * points, not UTF-16 units, so neither can be trusted to compare paths.
 */
export function isSameOrInsidePath(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return candidate.startsWith(prefix);
}

const makeFileSharesRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const create: FileSharesRepositoryShape["create"] = (row) =>
    sql`
      INSERT INTO file_shares (
        share_id, token, path, kind, created_at, expires_at, revoked_at,
        password_hash, access_count, last_accessed_at
      ) VALUES (
        ${row.shareId}, ${row.token}, ${row.path}, ${row.kind}, ${row.createdAt},
        ${row.expiresAt}, ${row.revokedAt}, ${row.passwordHash}, ${row.accessCount},
        ${row.lastAccessedAt}
      )
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("FileShares.create")));

  const getById: FileSharesRepositoryShape["getById"] = (shareId) =>
    sql<FileShareDbRow>`SELECT * FROM file_shares WHERE share_id = ${shareId}`.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toRow))),
      Effect.mapError(toPersistenceSqlError("FileShares.getById")),
    );

  const getByToken: FileSharesRepositoryShape["getByToken"] = (token) =>
    sql<FileShareDbRow>`SELECT * FROM file_shares WHERE token = ${token}`.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toRow))),
      Effect.mapError(toPersistenceSqlError("FileShares.getByToken")),
    );

  const list: FileSharesRepositoryShape["list"] = (input) =>
    (input.path === undefined
      ? sql<FileShareDbRow>`SELECT * FROM file_shares ORDER BY created_at DESC, share_id DESC`
      : sql<FileShareDbRow>`
          SELECT * FROM file_shares WHERE path = ${input.path}
          ORDER BY created_at DESC, share_id DESC
        `
    ).pipe(
      Effect.map((rows) => rows.map(toRow)),
      Effect.mapError(toPersistenceSqlError("FileShares.list")),
    );

  const revoke: FileSharesRepositoryShape["revoke"] = (input) =>
    sql<{ readonly share_id: string }>`
      UPDATE file_shares SET revoked_at = ${input.revokedAt}
      WHERE share_id = ${input.shareId} AND revoked_at IS NULL
      RETURNING share_id
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toPersistenceSqlError("FileShares.revoke")),
    );

  const allRows = sql<FileShareDbRow>`SELECT * FROM file_shares`.pipe(
    Effect.map((rows) => rows.map(toRow)),
  );

  const revokeUnder: FileSharesRepositoryShape["revokeUnder"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* allRows;
      const targets = rows.filter(
        (row) => row.revokedAt === null && isSameOrInsidePath(row.path, input.path),
      );
      for (const row of targets) {
        yield* sql`
          UPDATE file_shares SET revoked_at = ${input.revokedAt}
          WHERE share_id = ${row.shareId} AND revoked_at IS NULL
        `;
      }
      return targets.length;
    }).pipe(Effect.mapError(toPersistenceSqlError("FileShares.revokeUnder")));

  const repointPath: FileSharesRepositoryShape["repointPath"] = (input) =>
    Effect.gen(function* () {
      const rows = yield* allRows;
      for (const row of rows) {
        if (!isSameOrInsidePath(row.path, input.fromPath)) continue;
        const nextPath = input.toPath + row.path.slice(input.fromPath.length);
        yield* sql`UPDATE file_shares SET path = ${nextPath} WHERE share_id = ${row.shareId}`;
      }
    }).pipe(Effect.mapError(toPersistenceSqlError("FileShares.repointPath")));

  const recordAccess: FileSharesRepositoryShape["recordAccess"] = (input) =>
    sql`
      UPDATE file_shares
      SET access_count = access_count + 1, last_accessed_at = ${input.at}
      WHERE share_id = ${input.shareId}
    `.pipe(Effect.asVoid, Effect.mapError(toPersistenceSqlError("FileShares.recordAccess")));

  return {
    create,
    getById,
    getByToken,
    list,
    revoke,
    revokeUnder,
    repointPath,
    recordAccess,
  } satisfies FileSharesRepositoryShape;
});

export const FileSharesRepositoryLive = Layer.effect(
  FileSharesRepository,
  makeFileSharesRepository,
);
