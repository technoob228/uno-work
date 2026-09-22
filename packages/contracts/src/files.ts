/**
 * Files — the file manager of "This computer" (the `/files` screen).
 *
 * Every path is absolute and must stay inside the daemon's files root (the
 * Work user's home directory); the daemon re-checks that with `realpath`, so
 * `..` and symlinks cannot walk out of it. Shares are public links served by
 * the daemon at `/s/<token>` — one file, or one folder (as a listing or a
 * static website) — and nothing else on the machine.
 */
import { Schema } from "effect";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const FILES_PATH_MAX_LENGTH = 4096;
const FILES_NAME_MAX_LENGTH = 255;
export const FILES_SHARE_PASSWORD_MIN_LENGTH = 4;
export const FILES_SHARE_PASSWORD_MAX_LENGTH = 128;
/** Longest link lifetime a share can ask for: one year. */
export const FILES_SHARE_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
/** Where the daemon serves public share links. */
export const FILES_SHARE_ROUTE_PREFIX = "/s";
/** Owner-only raw bytes of a file (Range-capable); `?path=…&download=1`. */
export const FILES_RAW_ROUTE_PATH = "/api/files/raw";

const FilesPath = TrimmedNonEmptyString.check(Schema.isMaxLength(FILES_PATH_MAX_LENGTH));
const FilesName = TrimmedNonEmptyString.check(Schema.isMaxLength(FILES_NAME_MAX_LENGTH));

export const FilesEntryKind = Schema.Literals(["file", "directory"]);
export type FilesEntryKind = typeof FilesEntryKind.Type;

export const FilesEntry = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  kind: FilesEntryKind,
  /** Bytes for files; 0 for folders. */
  size: NonNegativeInt,
  /** ISO timestamp of the last content change. */
  modifiedAt: Schema.String,
  /** Dotfile, or inside a dot-folder. Hidden entries can't be shared. */
  hidden: Schema.Boolean,
  isSymlink: Schema.Boolean,
});
export type FilesEntry = typeof FilesEntry.Type;

export const FilesConflictPolicy = Schema.Literals(["fail", "replace", "keepBoth"]);
export type FilesConflictPolicy = typeof FilesConflictPolicy.Type;

export const FilesListInput = Schema.Struct({
  /** Folder to list; the files root when absent. */
  path: Schema.optional(FilesPath),
  showHidden: Schema.optional(Schema.Boolean),
});
export type FilesListInput = typeof FilesListInput.Type;

export const FilesListResult = Schema.Struct({
  path: Schema.String,
  /** The files root (the Work user's home). */
  rootPath: Schema.String,
  /** Null at the root. */
  parentPath: Schema.NullOr(Schema.String),
  entries: Schema.Array(FilesEntry),
});
export type FilesListResult = typeof FilesListResult.Type;

export const FilesStatInput = Schema.Struct({ path: FilesPath });
export type FilesStatInput = typeof FilesStatInput.Type;

export const FilesCreateFolderInput = Schema.Struct({
  parentPath: FilesPath,
  name: FilesName,
});
export type FilesCreateFolderInput = typeof FilesCreateFolderInput.Type;

export const FilesRenameInput = Schema.Struct({
  path: FilesPath,
  newName: FilesName,
  /** Defaults to `fail`. */
  onConflict: Schema.optional(FilesConflictPolicy),
});
export type FilesRenameInput = typeof FilesRenameInput.Type;

export const FilesMoveInput = Schema.Struct({
  paths: Schema.Array(FilesPath).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  destinationPath: FilesPath,
  /** Defaults to `keepBoth`. */
  onConflict: Schema.optional(FilesConflictPolicy),
});
export type FilesMoveInput = typeof FilesMoveInput.Type;

export const FilesMoveResult = Schema.Struct({ entries: Schema.Array(FilesEntry) });
export type FilesMoveResult = typeof FilesMoveResult.Type;

export const FilesDeleteInput = Schema.Struct({
  paths: Schema.Array(FilesPath).check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
});
export type FilesDeleteInput = typeof FilesDeleteInput.Type;

export const FilesDeleteResult = Schema.Struct({
  deleted: NonNegativeInt,
  /** Share links that pointed into what was deleted and were switched off. */
  revokedShares: NonNegativeInt,
});
export type FilesDeleteResult = typeof FilesDeleteResult.Type;

export const FilesSearchInput = Schema.Struct({
  /** Folder to search under; the files root when absent. */
  path: Schema.optional(FilesPath),
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  showHidden: Schema.optional(Schema.Boolean),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(500))),
});
export type FilesSearchInput = typeof FilesSearchInput.Type;

export const FilesSearchResult = Schema.Struct({
  entries: Schema.Array(FilesEntry),
  /** The walk stopped early (result limit or time budget). */
  truncated: Schema.Boolean,
});
export type FilesSearchResult = typeof FilesSearchResult.Type;

export const FilesShareKind = Schema.Literals(["file", "folder"]);
export type FilesShareKind = typeof FilesShareKind.Type;

export const FilesShare = Schema.Struct({
  id: Schema.String,
  token: Schema.String,
  path: Schema.String,
  name: Schema.String,
  kind: FilesShareKind,
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
  revokedAt: Schema.NullOr(Schema.String),
  hasPassword: Schema.Boolean,
  accessCount: NonNegativeInt,
  lastAccessedAt: Schema.NullOr(Schema.String),
  /** Path on the machine's address, e.g. `/s/<token>`. */
  urlPath: Schema.String,
});
export type FilesShare = typeof FilesShare.Type;

export const FilesShareCreateInput = Schema.Struct({
  path: FilesPath,
  /** Link lifetime; null or absent = until revoked. */
  expiresInSeconds: Schema.optional(
    Schema.NullOr(PositiveInt.check(Schema.isLessThanOrEqualTo(FILES_SHARE_MAX_TTL_SECONDS))),
  ),
  password: Schema.optional(
    Schema.NullOr(
      Schema.String.check(
        Schema.isMinLength(FILES_SHARE_PASSWORD_MIN_LENGTH),
        Schema.isMaxLength(FILES_SHARE_PASSWORD_MAX_LENGTH),
      ),
    ),
  ),
});
export type FilesShareCreateInput = typeof FilesShareCreateInput.Type;

export const FilesShareListInput = Schema.Struct({
  /** Only links for this exact path. */
  path: Schema.optional(FilesPath),
  /** Also return revoked and expired links. */
  includeInactive: Schema.optional(Schema.Boolean),
});
export type FilesShareListInput = typeof FilesShareListInput.Type;

export const FilesShareListResult = Schema.Struct({ shares: Schema.Array(FilesShare) });
export type FilesShareListResult = typeof FilesShareListResult.Type;

export const FilesShareRevokeInput = Schema.Struct({ id: TrimmedNonEmptyString });
export type FilesShareRevokeInput = typeof FilesShareRevokeInput.Type;

export const FilesPublishSiteInput = Schema.Struct({
  /** An HTML file (published with its folder) or a folder. */
  path: FilesPath,
  /** Optional site name: lowercase letters, digits and dashes. */
  slug: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(30))),
});
export type FilesPublishSiteInput = typeof FilesPublishSiteInput.Type;

export const FilesPublishSiteResult = Schema.Struct({
  slug: Schema.String,
  url: Schema.String,
  filesCount: NonNegativeInt,
  sizeBytes: NonNegativeInt,
});
export type FilesPublishSiteResult = typeof FilesPublishSiteResult.Type;

export class FilesError extends Schema.TaggedErrorClass<FilesError>()("FilesError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}
