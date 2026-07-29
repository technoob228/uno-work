import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";

import { ModelSelection, ProjectScript, RepositoryIdentity } from "@t3tools/contracts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionProjectInput,
  GetProjectionProjectInput,
  GetProjectionProjectRepositoryIdentityInput,
  ProjectionProject,
  ProjectionProjectRepository,
  ProjectionProjectRepositoryIdentityRow,
  UpsertProjectionProjectRepositoryIdentityInput,
  type ProjectionProjectRepositoryShape,
} from "../Services/ProjectionProjects.ts";

const ProjectionProjectDbRow = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
type ProjectionProjectDbRow = typeof ProjectionProjectDbRow.Type;

const ProjectionProjectRepositoryIdentityDbRow = ProjectionProjectRepositoryIdentityRow.mapFields(
  Struct.assign({
    repositoryIdentity: Schema.NullOr(Schema.fromJsonString(RepositoryIdentity)),
  }),
);

const makeProjectionProjectRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionProjectRow = SqlSchema.void({
    Request: ProjectionProject,
    execute: (row) =>
      sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.projectId},
          ${row.title},
          ${row.workspaceRoot},
          ${row.defaultModelSelection !== null ? JSON.stringify(row.defaultModelSelection) : null},
          ${JSON.stringify(row.scripts)},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (project_id)
        DO UPDATE SET
          title = excluded.title,
          workspace_root = excluded.workspace_root,
          default_model_selection_json = excluded.default_model_selection_json,
          scripts_json = excluded.scripts_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionProjectRow = SqlSchema.findOneOption({
    Request: GetProjectionProjectInput,
    Result: ProjectionProjectDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
      `,
  });

  const listProjectionProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRow,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const deleteProjectionProjectRow = SqlSchema.void({
    Request: DeleteProjectionProjectInput,
    execute: ({ projectId }) =>
      sql`
        DELETE FROM projection_projects
        WHERE project_id = ${projectId}
      `,
  });

  const listProjectionProjectRepositoryIdentityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectRepositoryIdentityDbRow,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          repository_identity_json AS "repositoryIdentity",
          repository_identity_resolved_at AS "resolvedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const getProjectionProjectRepositoryIdentityRow = SqlSchema.findOneOption({
    Request: GetProjectionProjectRepositoryIdentityInput,
    Result: ProjectionProjectRepositoryIdentityDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          repository_identity_json AS "repositoryIdentity",
          repository_identity_resolved_at AS "resolvedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
      `,
  });

  // UPDATE rather than upsert: the projected project row is owned by the
  // pipeline. If it is not there yet, there is nothing to annotate and
  // inventing a row would fabricate a project the event stream never created.
  const updateProjectionProjectRepositoryIdentityRow = SqlSchema.void({
    Request: UpsertProjectionProjectRepositoryIdentityInput,
    execute: (input) =>
      sql`
        UPDATE projection_projects
        SET
          repository_identity_json = ${JSON.stringify(input.repositoryIdentity)},
          repository_canonical_key = ${input.repositoryIdentity.canonicalKey},
          repository_identity_resolved_at = ${input.resolvedAt}
        WHERE project_id = ${input.projectId}
      `,
  });

  const upsert: ProjectionProjectRepositoryShape["upsert"] = (row) =>
    upsertProjectionProjectRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.upsert:query")),
    );

  const getById: ProjectionProjectRepositoryShape["getById"] = (input) =>
    getProjectionProjectRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.getById:query")),
    );

  const listAll: ProjectionProjectRepositoryShape["listAll"] = () =>
    listProjectionProjectRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.listAll:query")),
    );

  const deleteById: ProjectionProjectRepositoryShape["deleteById"] = (input) =>
    deleteProjectionProjectRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.deleteById:query")),
    );

  const listRepositoryIdentities: ProjectionProjectRepositoryShape["listRepositoryIdentities"] =
    () =>
      listProjectionProjectRepositoryIdentityRows().pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionProjectRepository.listRepositoryIdentities:query"),
        ),
      );

  const getRepositoryIdentity: ProjectionProjectRepositoryShape["getRepositoryIdentity"] = (
    input,
  ) =>
    getProjectionProjectRepositoryIdentityRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionProjectRepository.getRepositoryIdentity:query"),
      ),
    );

  const upsertRepositoryIdentity: ProjectionProjectRepositoryShape["upsertRepositoryIdentity"] = (
    input,
  ) =>
    updateProjectionProjectRepositoryIdentityRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionProjectRepository.upsertRepositoryIdentity:query"),
      ),
    );

  return {
    upsert,
    getById,
    listAll,
    deleteById,
    listRepositoryIdentities,
    getRepositoryIdentity,
    upsertRepositoryIdentity,
  } satisfies ProjectionProjectRepositoryShape;
});

export const ProjectionProjectRepositoryLive = Layer.effect(
  ProjectionProjectRepository,
  makeProjectionProjectRepository,
);
