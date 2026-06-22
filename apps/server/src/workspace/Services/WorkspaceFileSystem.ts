/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import { Schema, Context } from "effect";
import type { Effect, Stream } from "effect";

import type {
  FilesystemReadFileInput,
  FilesystemReadFileResult,
  FilesystemWatchFileEvent,
  FilesystemWatchFileInput,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import { WorkspacePathOutsideRootError } from "./WorkspacePaths.ts";

export class WorkspaceFileSystemError extends Schema.TaggedErrorClass<WorkspaceFileSystemError>()(
  "WorkspaceFileSystemError",
  {
    cwd: Schema.String,
    relativePath: Schema.optional(Schema.String),
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class WorkspaceReadFileError extends Schema.TaggedErrorClass<WorkspaceReadFileError>()(
  "WorkspaceReadFileError",
  {
    path: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export class WorkspaceWatchFileError extends Schema.TaggedErrorClass<WorkspaceWatchFileError>()(
  "WorkspaceWatchFileError",
  {
    path: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/**
 * WorkspaceFileSystemShape - Service API for workspace-relative file operations.
 */
export interface WorkspaceFileSystemShape {
  /**
   * Write a file relative to the workspace root.
   *
   * Creates parent directories as needed and rejects paths that escape the
   * workspace root.
   */
  readonly writeFile: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<
    ProjectWriteFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;

  /**
   * Read a file by absolute path. Returns content as utf8 or base64 with size +
   * truncation metadata. `~` prefix is expanded to the user home directory.
   */
  readonly readFile: (
    input: FilesystemReadFileInput,
  ) => Effect.Effect<FilesystemReadFileResult, WorkspaceReadFileError>;

  /**
   * Watch a file by absolute path. Emits an event whenever the file changes on
   * disk (including atomic replace-by-rename writes) until the stream is
   * interrupted by the subscriber.
   */
  readonly watchFile: (
    input: FilesystemWatchFileInput,
  ) => Stream.Stream<FilesystemWatchFileEvent, WorkspaceWatchFileError>;
}

/**
 * WorkspaceFileSystem - Service tag for workspace file operations.
 */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  WorkspaceFileSystemShape
>()("t3/workspace/Services/WorkspaceFileSystem") {}
