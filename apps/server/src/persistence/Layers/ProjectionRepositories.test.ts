import { ProjectId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.make("project-null-options"),
        title: "Null options project",
        workspaceRoot: "/tmp/project-null-options",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.fail(new Error("Expected projection_projects row to exist."));
      }

      assert.strictEqual(
        row.defaultModelSelection,
        JSON.stringify({
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        }),
      );

      const persisted = yield* projects.getById({
        projectId: ProjectId.make("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores JSON for thread model options", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-null-options"),
        projectId: ProjectId.make("project-null-options"),
        title: "Null options thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        pinnedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly modelSelection: string | null;
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.fail(new Error("Expected projection_threads row to exist."));
      }

      assert.strictEqual(
        row.modelSelection,
        JSON.stringify({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        }),
      );

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      });
    }),
  );
  const makeIdentity = (canonicalKey: string, rootPath: string) => ({
    canonicalKey,
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: `https://${canonicalKey}.git`,
    },
    rootPath,
  });

  const seedProject = (projectId: string) =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      yield* projects.upsert({
        projectId: ProjectId.make(projectId),
        title: projectId,
        workspaceRoot: `/tmp/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });
    });

  it.effect("starts with a null repository identity and stores one when resolved", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      yield* seedProject("project-identity-fresh");

      const before = yield* projects.getRepositoryIdentity({
        projectId: ProjectId.make("project-identity-fresh"),
      });
      assert.strictEqual(Option.getOrNull(before)?.repositoryIdentity, null);

      const identity = makeIdentity("github.com/example/repo", "/tmp/project-identity-fresh");
      yield* projects.upsertRepositoryIdentity({
        projectId: ProjectId.make("project-identity-fresh"),
        repositoryIdentity: identity,
        resolvedAt: "2026-03-24T01:00:00.000Z",
      });

      const after = yield* projects.getRepositoryIdentity({
        projectId: ProjectId.make("project-identity-fresh"),
      });
      assert.deepStrictEqual(Option.getOrNull(after)?.repositoryIdentity, identity);
      assert.strictEqual(Option.getOrNull(after)?.resolvedAt, "2026-03-24T01:00:00.000Z");
    }),
  );

  it.effect("mirrors the canonical key into its own indexed column", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* seedProject("project-identity-key");

      yield* projects.upsertRepositoryIdentity({
        projectId: ProjectId.make("project-identity-key"),
        repositoryIdentity: makeIdentity("github.com/example/keyed", "/tmp/project-identity-key"),
        resolvedAt: "2026-03-24T01:00:00.000Z",
      });

      const rows = yield* sql<{ readonly canonicalKey: string | null }>`
        SELECT repository_canonical_key AS "canonicalKey"
        FROM projection_projects
        WHERE project_id = 'project-identity-key'
      `;
      assert.strictEqual(rows[0]?.canonicalKey, "github.com/example/keyed");
    }),
  );

  // The invariant the whole cross-environment grouping rests on: a project that
  // momentarily fails to resolve keeps its previous answer. The projected-row
  // upsert is the realistic eraser — it runs on every `project.meta-updated`
  // and knows nothing about git.
  it.effect("keeps a stored identity when the projected project row is re-upserted", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      yield* seedProject("project-identity-survives");

      const identity = makeIdentity(
        "github.com/example/survivor",
        "/tmp/project-identity-survives",
      );
      yield* projects.upsertRepositoryIdentity({
        projectId: ProjectId.make("project-identity-survives"),
        repositoryIdentity: identity,
        resolvedAt: "2026-03-24T01:00:00.000Z",
      });

      yield* projects.upsert({
        projectId: ProjectId.make("project-identity-survives"),
        title: "Renamed by a later event",
        workspaceRoot: "/tmp/project-identity-survives",
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T02:00:00.000Z",
        deletedAt: null,
      });

      const after = yield* projects.getRepositoryIdentity({
        projectId: ProjectId.make("project-identity-survives"),
      });
      assert.deepStrictEqual(Option.getOrNull(after)?.repositoryIdentity, identity);
    }),
  );

  it.effect("ignores an identity written for a project that does not exist", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;

      yield* projects.upsertRepositoryIdentity({
        projectId: ProjectId.make("project-identity-absent"),
        repositoryIdentity: makeIdentity("github.com/example/ghost", "/tmp/ghost"),
        resolvedAt: "2026-03-24T01:00:00.000Z",
      });

      const after = yield* projects.getRepositoryIdentity({
        projectId: ProjectId.make("project-identity-absent"),
      });
      assert.strictEqual(Option.isNone(after), true);
    }),
  );

  it.effect("lists identities for every project, resolved or not", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      yield* seedProject("project-identity-list-a");
      yield* seedProject("project-identity-list-b");
      yield* projects.upsertRepositoryIdentity({
        projectId: ProjectId.make("project-identity-list-a"),
        repositoryIdentity: makeIdentity("github.com/example/listed", "/tmp/listed"),
        resolvedAt: "2026-03-24T01:00:00.000Z",
      });

      const rows = yield* projects.listRepositoryIdentities();
      const byId = new Map(rows.map((row) => [row.projectId, row.repositoryIdentity] as const));
      assert.strictEqual(
        byId.get(ProjectId.make("project-identity-list-a"))?.canonicalKey,
        "github.com/example/listed",
      );
      assert.strictEqual(byId.has(ProjectId.make("project-identity-list-b")), true);
      assert.strictEqual(byId.get(ProjectId.make("project-identity-list-b")), null);
    }),
  );
});
