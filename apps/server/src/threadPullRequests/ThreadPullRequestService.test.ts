import { assert, it } from "@effect/vitest";
import {
  type ChangeRequestStatus,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  SourceControlProviderError,
  type ThreadPullRequest,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "../project/Services/ProjectSetupScriptRunner.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type {
  ChangeRequestStatusQuery,
  ChangeRequestStatusRead,
} from "../sourceControl/SourceControlProvider.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { makeThreadPullRequests } from "./ThreadPullRequestService.ts";

const START = Date.parse("2026-10-30T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const threadId = ThreadId.make("thread-1");

const status = (overrides: Partial<ChangeRequestStatus> = {}): ChangeRequestStatus =>
  ({
    number: 12,
    title: "Fix login",
    url: "https://github.com/acme/app/pull/12",
    state: "open",
    isDraft: false,
    headRefName: "fix/login",
    baseRefName: "main",
    isCrossRepository: false,
    updatedAt: iso(START),
    mergedAt: null,
    closedAt: null,
    checks: "pending",
    review: "none",
    ...overrides,
  }) as ChangeRequestStatus;

interface World {
  now: number;
  devMode: boolean;
  autoSettleOnMerge: boolean;
  clients: boolean;
  shell: Partial<OrchestrationThreadShell>;
  reads: Array<ChangeRequestStatusQuery>;
  answer: (query: ChangeRequestStatusQuery) => ChangeRequestStatusRead;
  failWith: string | null;
  commands: Array<{ readonly type: string; readonly [key: string]: unknown }>;
  settleRuns: Array<{ readonly threadId: string; readonly worktreePath: string }>;
}

const newWorld = (): World => ({
  now: START,
  devMode: true,
  autoSettleOnMerge: true,
  clients: true,
  shell: {
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  },
  reads: [],
  answer: (query) => ({
    byNumber: new Map(),
    byBranch: new Map(query.branches.map((branch) => [branch, []])),
    budget: { remaining: 4900, limit: 5000, cost: 1, resetAt: iso(START + 3_600_000) },
  }),
  failWith: null,
  commands: [],
  settleRuns: [],
});

const syncedLinks = (world: World): ReadonlyArray<ThreadPullRequest> | undefined =>
  world.commands.findLast((command) => command.type === "thread.pull-requests.sync")
    ?.pullRequests as ReadonlyArray<ThreadPullRequest> | undefined;

const settles = (world: World) =>
  world.commands.filter((command) => command.type === "thread.settle");

const serviceFor = (world: World) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* makeThreadPullRequests({ now: () => world.now }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngineService)({
            dispatch: ((command: { readonly type: string; readonly [key: string]: unknown }) =>
              Effect.gen(function* () {
                world.commands.push(command);
                // The projection the engine would write.
                if (command.type === "thread.pull-requests.sync") {
                  const json = JSON.stringify(command.pullRequests);
                  yield* sql`
                    UPDATE projection_threads SET pull_requests_json = ${json}
                    WHERE thread_id = ${String(command.threadId)}
                  `;
                }
                if (command.type === "thread.settle") {
                  yield* sql`
                    UPDATE projection_threads SET settled_override = 'settled'
                    WHERE thread_id = ${String(command.threadId)}
                  `;
                }
                return { sequence: 1 };
              }).pipe(Effect.orDie)) as never,
            streamDomainEvents: Stream.empty,
          }),
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: () =>
              Effect.sync(() => Option.some(world.shell as OrchestrationThreadShell)),
          }),
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.sync(() => ({
              devMode: world.devMode,
              sidebarAutoSettleOnMerge: world.autoSettleOnMerge,
            })) as never,
          }),
          Layer.mock(SessionCredentialService)({
            cookieName: "test-session",
            listActive: () =>
              Effect.sync(() => (world.clients ? [{ connected: true }] : []) as never),
          }),
          Layer.mock(SourceControlProviderRegistry)({
            resolveHandle: () =>
              Effect.succeed({
                provider: {
                  readChangeRequestStatuses: (query: ChangeRequestStatusQuery) =>
                    Effect.suspend(() => {
                      world.reads.push(query);
                      return world.failWith === null
                        ? Effect.succeed(world.answer(query))
                        : Effect.fail(
                            new SourceControlProviderError({
                              provider: "github",
                              operation: "readChangeRequestStatuses",
                              detail: world.failWith,
                            }),
                          );
                    }),
                } as never,
                context: {
                  provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/app.git",
                },
              }),
          }),
          Layer.mock(ProjectSetupScriptRunner)({
            runForThread: (input) =>
              Effect.sync(() => {
                world.settleRuns.push(input);
                return { status: "no-script" } as const;
              }),
          }),
          Layer.mock(VcsProcess.VcsProcess)({
            run: () =>
              Effect.succeed({
                exitCode: 0,
                stdout: "origin/main\n",
                stderr: "",
              } as never),
          }),
        ),
      ),
    );
  });

const seed = (overrides: {
  readonly branch?: string | null;
  readonly pullRequests?: ReadonlyArray<unknown> | null;
  readonly latestPersonMessageAt?: string | null;
  readonly updatedAt?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql`DELETE FROM projection_threads`;
    yield* sql`DELETE FROM projection_projects`;
    const created = iso(START - 600_000);
    yield* sql`
      INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project-1', 'App', '/work/app', '[]', ${created}, ${created})
    `;
    const links =
      overrides.pullRequests === undefined || overrides.pullRequests === null
        ? null
        : JSON.stringify(overrides.pullRequests);
    yield* sql`
      INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
         branch, worktree_path, created_at, updated_at, pull_requests_json,
         latest_person_message_at, latest_user_message_at)
      VALUES
        (${threadId}, 'project-1', 'Fix', '{"instanceId":"codex","model":"gpt"}', 'full-access',
         'default', ${overrides.branch === undefined ? "fix/login" : overrides.branch}, NULL,
         ${created}, ${overrides.updatedAt ?? iso(START - 60_000)}, ${links},
         ${overrides.latestPersonMessageAt ?? created}, ${overrides.latestPersonMessageAt ?? created})
    `;
  });

const openLink = {
  provider: "github",
  repository: "acme/app",
  number: 12,
  url: "https://github.com/acme/app/pull/12",
  source: "branch",
  linkedAt: iso(START - 300_000),
  snapshot: {
    title: "Fix login",
    state: "open",
    isDraft: false,
    headBranch: "fix/login",
    baseBranch: "main",
    updatedAt: iso(START - 60_000),
    mergedAt: null,
    closedAt: null,
    checks: "pending",
    review: "none",
    syncedAt: iso(START - 60_000),
  },
};

const mergedAnswer = (world: World, mergedAt: string) => {
  world.answer = () => ({
    byNumber: new Map([[12, status({ state: "merged", mergedAt })]]),
    byBranch: new Map(),
    budget: null,
  });
};

const shellEvent = (command: string, output: string) =>
  ({
    type: "thread.activity-appended",
    payload: {
      threadId,
      activity: {
        kind: "tool.completed",
        payload: {
          itemType: "command_execution",
          data: { input: { command }, result: { content: output } },
        },
      },
    },
  }) as unknown as OrchestrationEvent;

const turnEnded = {
  type: "thread.session-set",
  payload: { threadId, session: { status: "ready" } },
} as unknown as OrchestrationEvent;

const layer = it.layer(NodeSqliteClient.layerMemory());

layer("ThreadPullRequestService", (it) => {
  it.effect("doesn't touch the host without Dev mode", () =>
    Effect.gen(function* () {
      const world = newWorld();
      world.devMode = false;
      yield* seed({});
      const service = yield* serviceFor(world);
      yield* service.tick;
      yield* service.onDomainEvent(turnEnded);
      yield* service.drain;
      assert.equal(world.reads.length, 0);
      assert.equal(world.commands.length, 0);
    }),
  );

  it.effect("the minute sweep pauses with no client connected", () =>
    Effect.gen(function* () {
      const world = newWorld();
      world.clients = false;
      yield* seed({});
      const service = yield* serviceFor(world);
      yield* service.tick;
      yield* service.drain;
      assert.equal(world.reads.length, 0);
    }),
  );

  it.effect("a turn's end still reads with no client connected", () =>
    Effect.gen(function* () {
      const world = newWorld();
      world.clients = false;
      yield* seed({});
      const service = yield* serviceFor(world);
      yield* service.onDomainEvent(turnEnded);
      yield* service.drain;
      assert.equal(world.reads.length, 1);
    }),
  );

  it.effect("finds the PR by the branch and stores it", () =>
    Effect.gen(function* () {
      const world = newWorld();
      world.answer = () => ({
        byNumber: new Map(),
        byBranch: new Map([["fix/login", [status()]]]),
        budget: null,
      });
      yield* seed({});
      const service = yield* serviceFor(world);
      yield* service.tick;
      yield* service.drain;
      assert.deepEqual(world.reads[0]?.branches, ["fix/login"]);
      assert.equal(world.reads[0]?.repository, "acme/app");
      assert.equal(syncedLinks(world)?.[0]?.number, 12);
      assert.equal(syncedLinks(world)?.[0]?.source, "branch");
    }),
  );

  it.effect("never asks about the default branch", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* seed({ branch: "main" });
      const service = yield* serviceFor(world);
      yield* service.tick;
      yield* service.drain;
      assert.equal(world.reads.length, 0);
    }),
  );

  it.effect("an open PR doesn't cost a second question about its branch", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* seed({ pullRequests: [openLink] });
      const service = yield* serviceFor(world);
      yield* service.tick;
      yield* service.drain;
      assert.deepEqual(world.reads[0]?.numbers, [12]);
      assert.deepEqual(world.reads[0]?.branches, []);
    }),
  );

  it.effect("writes nothing when the PR didn't move", () =>
    Effect.gen(function* () {
      const world = newWorld();
      world.answer = () => ({
        byNumber: new Map([[12, status({ updatedAt: iso(START - 60_000) })]]),
        byBranch: new Map(),
        budget: null,
      });
      yield* seed({ pullRequests: [openLink] });
      const service = yield* serviceFor(world);
      yield* service.tick;
      yield* service.drain;
      assert.equal(world.reads.length, 1);
      assert.equal(world.commands.length, 0);
    }),
  );

  it.effect("a quiet PR is read less often than a live one", () =>
    Effect.gen(function* () {
      const world = newWorld();
      const quiet = {
        ...openLink,
        snapshot: { ...openLink.snapshot, updatedAt: iso(START - 3_600_000) },
      };
      world.answer = () => ({
        byNumber: new Map([[12, status({ updatedAt: iso(START - 3_600_000) })]]),
        byBranch: new Map(),
        budget: null,
      });
      yield* seed({ pullRequests: [quiet] });
      const service = yield* serviceFor(world);
      yield* service.tick;
      yield* service.drain;
      world.now += 60_000;
      yield* service.tick;
      yield* service.drain;
      assert.equal(world.reads.length, 1);
      world.now += 4 * 60_000;
      yield* service.tick;
      yield* service.drain;
      assert.equal(world.reads.length, 2);
    }),
  );

  it.effect("settles after a merge later than the person's last message", () =>
    Effect.gen(function* () {
      const world = newWorld();
      mergedAnswer(world, iso(START - 1_000));
      yield* seed({ pullRequests: [openLink] });
      const service = yield* serviceFor(world);
      yield* service.tick;
      yield* service.drain;
      assert.equal(settles(world).length, 1);
    }),
  );

  it.effect("stays when the person wrote after the merge", () =>
    Effect.gen(function* () {
      const world = newWorld();
      mergedAnswer(world, iso(START - 60_000));
      yield* seed({ pullRequests: [openLink], latestPersonMessageAt: iso(START - 1_000) });
      const service = yield* serviceFor(world);
      yield* service.tick;
      yield* service.drain;
      assert.equal(settles(world).length, 0);
      assert.equal(syncedLinks(world)?.[0]?.snapshot?.state, "merged");
    }),
  );

  it.effect("waits for a working agent, then settles", () =>
    Effect.gen(function* () {
      const world = newWorld();
      world.shell = {
        ...world.shell,
        session: { status: "running", activeTurnId: "turn-1" } as never,
      };
      mergedAnswer(world, iso(START - 1_000));
      yield* seed({ pullRequests: [openLink] });
      const service = yield* serviceFor(world);
      yield* service.tick;
      yield* service.drain;
      assert.equal(settles(world).length, 0);

      world.shell = { ...world.shell, session: { status: "ready", activeTurnId: null } as never };
      world.now += 60_000;
      yield* service.onDomainEvent(turnEnded);
      yield* service.drain;
      assert.equal(settles(world).length, 1);
    }),
  );

  it.effect("links what `gh pr create` printed and reads it right away", () =>
    Effect.gen(function* () {
      const world = newWorld();
      world.answer = () => ({
        byNumber: new Map([[12, status()]]),
        byBranch: new Map(),
        budget: null,
      });
      yield* seed({ branch: null });
      const service = yield* serviceFor(world);
      yield* service.onDomainEvent(
        shellEvent("gh pr create --fill", "https://github.com/acme/app/pull/12\n"),
      );
      yield* service.drain;
      assert.equal(syncedLinks(world)?.[0]?.source, "created");
      assert.equal(syncedLinks(world)?.[0]?.snapshot?.title, "Fix login");
      assert.deepEqual(world.reads[0]?.numbers, [12]);
    }),
  );

  it.effect("`gh pr merge` in a shell reads the PR at once, without waiting for the minute", () =>
    Effect.gen(function* () {
      const world = newWorld();
      mergedAnswer(world, iso(START - 1_000));
      yield* seed({ pullRequests: [openLink] });
      const service = yield* serviceFor(world);
      yield* service.onDomainEvent(shellEvent("gh pr merge 12 --squash", ""));
      yield* service.drain;
      assert.equal(world.reads.length, 1);
      assert.equal(settles(world).length, 1);
    }),
  );

  it.effect("backs off the whole host after a limit error", () =>
    Effect.gen(function* () {
      const world = newWorld();
      world.failWith = "GraphQL: API rate limit exceeded for user";
      yield* seed({ pullRequests: [openLink] });
      const service = yield* serviceFor(world);
      yield* service.tick;
      yield* service.drain;
      assert.equal(world.reads.length, 1);
      world.now += 60_000;
      yield* service.tick;
      yield* service.drain;
      assert.equal(world.reads.length, 1);
      world.now += 15 * 60_000;
      yield* service.tick;
      yield* service.drain;
      assert.equal(world.reads.length, 2);
    }),
  );

  it.effect("runs the project's action on settle once, in the chat's worktree", () =>
    Effect.gen(function* () {
      const world = newWorld();
      world.shell = {
        ...world.shell,
        projectId: "project-1",
        worktreePath: "/copies/fix",
      } as never;
      yield* seed({});
      const service = yield* serviceFor(world);
      const settled = {
        type: "thread.settled",
        payload: { threadId, settledAt: iso(START), updatedAt: iso(START) },
      } as unknown as OrchestrationEvent;
      yield* service.onDomainEvent(settled);
      yield* service.onDomainEvent(settled);
      assert.equal(world.settleRuns.length, 1);
      assert.equal(world.settleRuns[0]?.worktreePath, "/copies/fix");
    }),
  );

  it.effect("leaves a shared checkout alone on settle", () =>
    Effect.gen(function* () {
      const world = newWorld();
      world.shell = { ...world.shell, projectId: "project-1", worktreePath: null } as never;
      yield* seed({});
      const service = yield* serviceFor(world);
      yield* service.onDomainEvent({
        type: "thread.settled",
        payload: { threadId, settledAt: iso(START), updatedAt: iso(START) },
      } as unknown as OrchestrationEvent);
      assert.equal(world.settleRuns.length, 0);
    }),
  );

  it.effect("leaves the last tenth of the hourly budget alone", () =>
    Effect.gen(function* () {
      const world = newWorld();
      world.answer = () => ({
        byNumber: new Map([[12, status()]]),
        byBranch: new Map(),
        budget: { remaining: 100, limit: 5000, cost: 1, resetAt: iso(START + 1_800_000) },
      });
      yield* seed({ pullRequests: [openLink] });
      const service = yield* serviceFor(world);
      yield* service.tick;
      yield* service.drain;
      world.now += 60_000;
      yield* service.tick;
      yield* service.drain;
      assert.equal(world.reads.length, 1);
      world.now = START + 1_800_001;
      yield* service.tick;
      yield* service.drain;
      assert.equal(world.reads.length, 2);
    }),
  );
});
