import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const FILESYSTEM_PATH_MAX_LENGTH = 512;
const READ_FILE_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const READ_FILE_HARD_MAX_BYTES = 25 * 1024 * 1024;

export const FilesystemEntryKind = Schema.Literals(["file", "directory"]);
export type FilesystemEntryKind = typeof FilesystemEntryKind.Type;

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  cwd: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH))),
  includeFiles: Schema.optional(Schema.Boolean),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  fullPath: TrimmedNonEmptyString,
  kind: FilesystemEntryKind,
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: TrimmedNonEmptyString,
  entries: Schema.Array(FilesystemBrowseEntry),
});
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;

export class FilesystemBrowseError extends Schema.TaggedErrorClass<FilesystemBrowseError>()(
  "FilesystemBrowseError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const FILESYSTEM_READ_FILE_DEFAULT_MAX_BYTES = READ_FILE_DEFAULT_MAX_BYTES;
export const FILESYSTEM_READ_FILE_HARD_MAX_BYTES = READ_FILE_HARD_MAX_BYTES;

export const FilesystemReadFileEncoding = Schema.Literals(["utf8", "base64"]);
export type FilesystemReadFileEncoding = typeof FilesystemReadFileEncoding.Type;

export const FilesystemReadFileInput = Schema.Struct({
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH)),
  maxBytes: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(READ_FILE_HARD_MAX_BYTES)),
  ),
});
export type FilesystemReadFileInput = typeof FilesystemReadFileInput.Type;

export const FilesystemReadFileResult = Schema.Struct({
  content: Schema.String,
  encoding: FilesystemReadFileEncoding,
  size: NonNegativeInt,
  truncated: Schema.Boolean,
  mimeType: Schema.optional(TrimmedNonEmptyString),
});
export type FilesystemReadFileResult = typeof FilesystemReadFileResult.Type;

export class FilesystemReadFileError extends Schema.TaggedErrorClass<FilesystemReadFileError>()(
  "FilesystemReadFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
