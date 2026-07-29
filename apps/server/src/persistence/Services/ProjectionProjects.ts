/**
 * ProjectionProjectRepository - Projection repository interface for projects.
 *
 * Owns persistence operations for project rows in the orchestration projection
 * read model.
 *
 * @module ProjectionProjectRepository
 */
import {
  IsoDateTime,
  ModelSelection,
  ProjectId,
  ProjectScript,
  RepositoryIdentity,
} from "@t3tools/contracts";
import { Option, Schema, Context } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionProject = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  workspaceRoot: Schema.String,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionProject = typeof ProjectionProject.Type;

export const GetProjectionProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type GetProjectionProjectInput = typeof GetProjectionProjectInput.Type;

export const DeleteProjectionProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type DeleteProjectionProjectInput = typeof DeleteProjectionProjectInput.Type;

/**
 * A project's last-known-good repository identity.
 *
 * Stored alongside the projected project row but deliberately *not* part of
 * `ProjectionProject`: identity comes from `git`, not from the event stream, so
 * folding it into the projected row would have every `project.meta-updated`
 * replay overwrite it with whatever the projector happened to know (usually
 * nothing).
 */
export const ProjectionProjectRepositoryIdentityRow = Schema.Struct({
  projectId: ProjectId,
  repositoryIdentity: Schema.NullOr(RepositoryIdentity),
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionProjectRepositoryIdentityRow =
  typeof ProjectionProjectRepositoryIdentityRow.Type;

export const GetProjectionProjectRepositoryIdentityInput = Schema.Struct({
  projectId: ProjectId,
});
export type GetProjectionProjectRepositoryIdentityInput =
  typeof GetProjectionProjectRepositoryIdentityInput.Type;

/**
 * Note the non-nullable `repositoryIdentity`: last-known-good is enforced by
 * construction, so no caller can express "forget what we knew". A repository
 * that momentarily fails to resolve — git off PATH, a sleeping network mount,
 * a checkout mid-rebase — keeps its previous answer instead of making every
 * cross-environment project group blink apart and back together.
 */
export const UpsertProjectionProjectRepositoryIdentityInput = Schema.Struct({
  projectId: ProjectId,
  repositoryIdentity: RepositoryIdentity,
  resolvedAt: IsoDateTime,
});
export type UpsertProjectionProjectRepositoryIdentityInput =
  typeof UpsertProjectionProjectRepositoryIdentityInput.Type;

/**
 * ProjectionProjectRepositoryShape - Service API for projected project records.
 */
export interface ProjectionProjectRepositoryShape {
  /**
   * Insert or replace a projected project row.
   *
   * Upserts by `projectId` and persists scripts through JSON encoding.
   */
  readonly upsert: (row: ProjectionProject) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected project row by id.
   */
  readonly getById: (
    input: GetProjectionProjectInput,
  ) => Effect.Effect<Option.Option<ProjectionProject>, ProjectionRepositoryError>;

  /**
   * List all projected project rows.
   *
   * Returned in deterministic creation order.
   */
  readonly listAll: () => Effect.Effect<
    ReadonlyArray<ProjectionProject>,
    ProjectionRepositoryError
  >;

  /**
   * Soft-delete a projected project row by id.
   */
  readonly deleteById: (
    input: DeleteProjectionProjectInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read every project's stored repository identity.
   *
   * Includes rows whose identity is still `null` so callers can tell "never
   * resolved" apart from "project does not exist".
   */
  readonly listRepositoryIdentities: () => Effect.Effect<
    ReadonlyArray<ProjectionProjectRepositoryIdentityRow>,
    ProjectionRepositoryError
  >;

  /**
   * Read one project's stored repository identity.
   */
  readonly getRepositoryIdentity: (
    input: GetProjectionProjectRepositoryIdentityInput,
  ) => Effect.Effect<
    Option.Option<ProjectionProjectRepositoryIdentityRow>,
    ProjectionRepositoryError
  >;

  /**
   * Record a freshly resolved repository identity for an existing project.
   *
   * A no-op when the project row is absent — identity is an annotation on a
   * projected row, never a reason to create one.
   */
  readonly upsertRepositoryIdentity: (
    input: UpsertProjectionProjectRepositoryIdentityInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionProjectRepository - Service tag for project projection persistence.
 */
export class ProjectionProjectRepository extends Context.Service<
  ProjectionProjectRepository,
  ProjectionProjectRepositoryShape
>()("t3/persistence/Services/ProjectionProjects/ProjectionProjectRepository") {}
