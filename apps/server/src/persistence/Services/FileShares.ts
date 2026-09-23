/**
 * FileSharesRepository — durable rows behind the Files app's public links.
 *
 * One row = one `/s/<token>` link to one absolute path. Rows are never
 * deleted: revoking stamps `revoked_at`, so "my links" can show history and a
 * revoked token can never be reissued. Renames and moves in the Files app
 * re-point rows (`repointPath`) so a link follows its file.
 *
 * @module FileSharesRepository
 */
import { Context, Option } from "effect";
import type { Effect } from "effect";

import type { PersistenceSqlError } from "../Errors.ts";

export interface FileShareRow {
  readonly shareId: string;
  readonly token: string;
  readonly path: string;
  readonly kind: "file" | "folder";
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly passwordHash: string | null;
  /** view | comment | edit — see FilesShareAccess. */
  readonly access: "view" | "comment" | "edit";
  readonly accessCount: number;
  readonly lastAccessedAt: string | null;
}

export interface FileSharesRepositoryShape {
  readonly create: (row: FileShareRow) => Effect.Effect<void, PersistenceSqlError>;
  readonly getById: (
    shareId: string,
  ) => Effect.Effect<Option.Option<FileShareRow>, PersistenceSqlError>;
  readonly getByToken: (
    token: string,
  ) => Effect.Effect<Option.Option<FileShareRow>, PersistenceSqlError>;
  /** Newest first; optionally only rows for one exact path. */
  readonly list: (input: {
    readonly path?: string | undefined;
  }) => Effect.Effect<ReadonlyArray<FileShareRow>, PersistenceSqlError>;
  /** Stamps `revoked_at` if not yet revoked. Returns true when it changed. */
  readonly revoke: (input: {
    readonly shareId: string;
    readonly revokedAt: string;
  }) => Effect.Effect<boolean, PersistenceSqlError>;
  /** Revoke every live link at `path` or anywhere under it. Returns the count. */
  readonly revokeUnder: (input: {
    readonly path: string;
    readonly revokedAt: string;
  }) => Effect.Effect<number, PersistenceSqlError>;
  /** A file/folder moved: links at `fromPath` (or under it) follow to `toPath`. */
  readonly repointPath: (input: {
    readonly fromPath: string;
    readonly toPath: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly recordAccess: (input: {
    readonly shareId: string;
    readonly at: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
}

export class FileSharesRepository extends Context.Service<
  FileSharesRepository,
  FileSharesRepositoryShape
>()("t3/persistence/Services/FileShares/FileSharesRepository") {}
