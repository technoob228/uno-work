import {
  CheckpointRef,
  DEFAULT_MODEL,
  type OrchestrationCommand,
  type OrchestrationCommandOrigin,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  THREAD_CONTINUE_CHUNK_BYTES,
  THREAD_CONTINUE_LEGACY_CLIENT_MESSAGE,
  THREAD_CONTINUE_MAX_BUNDLE_BYTES,
  ThreadContinueError,
  type ThreadContinueLandInput,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { describe } from "vitest";

import type { ContinueTransferStoreShape } from "../git/continueTransferStore.ts";
import type { ContinueTransportShape } from "../git/continueTransport.ts";
import {
  continueBranchName,
  type ContinueOnMachineDeps,
  makeThreadContinueComplete,
  makeThreadContinueInspect,
  makeThreadContinueLand,
  makeThreadContinueLegacyRefusal,
  makeThreadContinueSnapshot,
  resolveTargetModelSelection,
} from "./continueOnMachine.ts";
import { CONTINUE_SEED_PREFIX, HANDOFF_PREAMBLE_START } from "./handoff.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const NOW = "2026-09-12T10:00:00.000Z";
const TRANSFER_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const TRANSFER_REF = `refs/t3/continue/${TRANSFER_ID}`;
const WORKTREES = "/home/unowork/.t3/worktrees";

const provider = (input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly models?: ReadonlyArray<string>;
  readonly installed?: boolean;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make(input.driver),
  enabled: true,
  installed: input.installed ?? true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: (input.models ?? []).map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
});

const codex = provider({ instanceId: "codex", driver: "codex", models: [DEFAULT_MODEL] });
const claude = provider({
  instanceId: "claudeAgent",
  driver: "claude",
  models: ["claude-sonnet-4-6"],
});
const CLAUDE_SELECTION = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};
const CODEX_SELECTION = { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL };

const projectShell = (
  overrides: Partial<OrchestrationProjectShell> = {},
): OrchestrationProjectShell =>
  ({
    id: PROJECT_ID,
    title: "Uno Work",
    workspaceRoot: "/Users/dev/uno",
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }) as unknown as OrchestrationProjectShell;

const threadDetail = (overrides: Partial<OrchestrationThread> = {}): OrchestrationThread =>
  ({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Fix login",
    modelSelection: CLAUDE_SELECTION,
    runtimeMode: "auto-accept-edits",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    messages: [
      {
        id: "m1",
        role: "user",
        text: "please fix login",
        turnId: null,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "m2",
        role: "assistant",
        text: "done, see auth.ts",
        turnId: "turn-1",
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  }) as unknown as OrchestrationThread;

const threadShell = (overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell =>
  ({
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Fix login",
    modelSelection: CLAUDE_SELECTION,
    runtimeMode: "auto-accept-edits",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    session: null,
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

interface Call {
  readonly op: string;
  readonly input: unknown;
}

interface Fixture {
  readonly deps: ContinueOnMachineDeps;
  readonly dispatched: Array<{
    readonly command: OrchestrationCommand;
    readonly origin: OrchestrationCommandOrigin | undefined;
  }>;
  readonly transportCalls: Call[];
  readonly transferCalls: Call[];
  readonly envReads: string[];
  readonly writtenEnv: Array<{ readonly folder: string; readonly text: string }>;
  readonly clones: Array<{ readonly remoteUrl: string; readonly destinationPath: string }>;
  readonly madeDirectories: string[];
}

const DIGEST = { sizeBytes: 5 * 1024 * 1024, sha256: "abc123" };

function makeFixture(options?: {
  readonly thread?: Option.Option<OrchestrationThread>;
  readonly threadShell?: Option.Option<OrchestrationThreadShell>;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly transport?: Partial<ContinueTransportShape>;
  readonly transfers?: Partial<ContinueTransferStoreShape>;
  readonly envFiles?: Readonly<Record<string, string>>;
  readonly existingDirectories?: ReadonlySet<string>;
  readonly writeEnvFails?: boolean;
}): Fixture {
  const dispatched: Fixture["dispatched"] = [];
  const transportCalls: Call[] = [];
  const transferCalls: Call[] = [];
  const envReads: string[] = [];
  const writtenEnv: Fixture["writtenEnv"] = [];
  const clones: Fixture["clones"] = [];
  const madeDirectories: string[] = [];
  const projects = [...(options?.projects ?? [projectShell()])];

  const recordAll = <T extends object>(calls: Call[], impl: T): T =>
    Object.fromEntries(
      Object.entries(impl).map(([op, value]) => [
        op,
        typeof value === "function"
          ? (...args: unknown[]) => {
              calls.push({ op, input: args.length === 1 ? args[0] : args });
              return (value as (...inner: unknown[]) => unknown)(...args);
            }
          : Effect.suspend(() => {
              calls.push({ op, input: undefined });
              return value as Effect.Effect<unknown>;
            }),
      ]),
    ) as T;

  const baseTransport: ContinueTransportShape = {
    isGitRepository: () => Effect.succeed(true),
    readStatus: () => Effect.succeed({ commit: "headsha", branch: "feat/login", changedFiles: 0 }),
    resolveRemote: () => Effect.succeed({ name: "origin", url: "git@github.com:uno/uno.git" }),
    readHead: () => Effect.succeed({ commit: "headsha", branch: "feat/login" }),
    captureSnapshot: () => Effect.succeed("wipsha"),
    createBundle: () => Effect.void,
    verifyBundle: () => Effect.succeed({ ok: true, detail: "" }),
    fetchRemotes: () => Effect.void,
    fetchBundle: () => Effect.succeed("wipsha"),
    initRepository: () => Effect.void,
    branchExists: () => Effect.succeed(false),
    addWorktree: () => Effect.void,
    restoreTree: () => Effect.succeed(true),
    deleteRef: () => Effect.void,
  };
  const baseTransfers: ContinueTransferStoreShape = {
    prepareOutgoing: (id) => Effect.succeed(`/scratch/outgoing/${id}.bundle`),
    digest: () => Effect.succeed(DIGEST),
    incomingPath: (id) => Effect.succeed(`/scratch/incoming/${id}.bundle`),
    readChunk: () => Effect.succeed(""),
    writeChunk: () => Effect.succeed(0),
    discard: () => Effect.succeed(true),
    sweep: Effect.void,
  };

  const deps: ContinueOnMachineDeps = {
    transport: recordAll(transportCalls, { ...baseTransport, ...options?.transport }),
    transfers: recordAll(transferCalls, { ...baseTransfers, ...options?.transfers }),
    worktreesDir: WORKTREES,
    projections: {
      getThreadDetailById: () => Effect.succeed(options?.thread ?? Option.some(threadDetail())),
      getThreadShellById: () => Effect.succeed(options?.threadShell ?? Option.some(threadShell())),
      getProjectShellById: (projectId) =>
        Effect.succeed(Option.fromNullishOr(projects.find((project) => project.id === projectId))),
      getShellSnapshot: () =>
        Effect.succeed({ snapshotSequence: 1, projects, threads: [], updatedAt: NOW }),
      getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none<ThreadId>()),
    },
    engine: {
      dispatch: (command, dispatchOptions) =>
        Effect.sync(() => {
          dispatched.push({ command, origin: dispatchOptions?.origin });
          if (command.type === "project.create") {
            projects.push(
              projectShell({
                id: command.projectId,
                title: command.title,
                workspaceRoot: command.workspaceRoot,
              }),
            );
          }
          return { sequence: dispatched.length };
        }),
    },
    getProviders: Effect.succeed(options?.providers ?? [codex, claude]),
    getMachineLabel: Effect.succeed("Misha's Mac"),
    readEnvFile: (folder) =>
      Effect.sync(() => {
        envReads.push(folder);
        return options?.envFiles?.[folder] ?? null;
      }),
    writeEnvFile: (folder, text) =>
      options?.writeEnvFails
        ? Effect.fail(new Error("disk full"))
        : Effect.sync(() => {
            writtenEnv.push({ folder, text });
          }),
    cloneRepository: (input) =>
      Effect.sync(() => {
        clones.push(input);
        return { cwd: input.destinationPath };
      }),
    directoryExists: (path) => Effect.succeed(options?.existingDirectories?.has(path) ?? false),
    makeDirectory: (path) =>
      Effect.sync(() => {
        madeDirectories.push(path);
      }),
    expandPath: (path) => path.replace(/^~/, "/home/unowork"),
    now: () => NOW,
    newTransferId: () => TRANSFER_ID,
  };

  return {
    deps,
    dispatched,
    transportCalls,
    transferCalls,
    envReads,
    writtenEnv,
    clones,
    madeDirectories,
  };
}

const expectFailure = <A>(effect: Effect.Effect<A, ThreadContinueError>) => Effect.flip(effect);

function callInput<T>(calls: ReadonlyArray<Call>, op: string): T {
  const call = calls.find((candidate) => candidate.op === op);
  if (!call) {
    assert.fail(`expected a ${op} call`);
  }
  return call.input as T;
}

const ops = (calls: ReadonlyArray<Call>) => calls.map((call) => call.op);

describe("continue branch naming", () => {
  it("uses a short, git-safe id and numbers repeats", () => {
    assert.equal(continueBranchName("thread-1"), "uno/continue/thread-1");
    assert.equal(
      continueBranchName("7F3A9C1E-0000-4000-8000-000000000000", 3),
      "uno/continue/7f3a9c1e-000-3",
    );
    assert.equal(continueBranchName("../weird id!!"), "uno/continue/weird-id");
    assert.equal(continueBranchName("///"), "uno/continue/chat");
  });
});

describe("thread.continue.snapshot", () => {
  it.effect(
    "snapshots onto HEAD, bundles it without pushing, drops the hidden ref and returns the digest",
    () =>
      Effect.gen(function* () {
        const fixture = makeFixture();
        const result = yield* makeThreadContinueSnapshot(fixture.deps)({ threadId: THREAD_ID });

        assert.deepEqual(callInput(fixture.transportCalls, "captureSnapshot"), {
          cwd: "/Users/dev/uno",
          ref: CheckpointRef.make(TRANSFER_REF),
          parents: ["headsha"],
          message: "uno continue: Fix login",
        });
        assert.deepEqual(callInput(fixture.transportCalls, "createBundle"), {
          cwd: "/Users/dev/uno",
          ref: CheckpointRef.make(TRANSFER_REF),
          bundlePath: `/scratch/outgoing/${TRANSFER_ID}.bundle`,
        });
        const transportOps = ops(fixture.transportCalls);
        assert.isAbove(transportOps.indexOf("deleteRef"), transportOps.indexOf("createBundle"));
        assert.deepEqual(ops(fixture.transferCalls).slice(0, 3), [
          "sweep",
          "prepareOutgoing",
          "digest",
        ]);

        assert.equal(result.transferId, TRANSFER_ID);
        assert.equal(result.sizeBytes, DIGEST.sizeBytes);
        assert.equal(result.sha256, DIGEST.sha256);
        assert.equal(result.chunkBytes, THREAD_CONTINUE_CHUNK_BYTES);
        assert.equal(result.chunkCount, 3);
        assert.equal(result.commit, "wipsha");
        assert.equal(result.baseCommit, "headsha");
        assert.equal(result.sourceBranch, "feat/login");
        assert.equal(result.remoteUrl, "git@github.com:uno/uno.git");
        assert.equal(result.sourceMachineLabel, "Misha's Mac");
        assert.deepEqual(result.modelSelection, CLAUDE_SELECTION);
        assert.isTrue(result.seedText.startsWith(`${CONTINUE_SEED_PREFIX}Misha's Mac]`));
        assert.include(result.seedText, HANDOFF_PREAMBLE_START);
        assert.include(result.seedText, "User: please fix login");
        assert.equal(fixture.dispatched.length, 0);
      }),
  );

  it.effect("leaves .env behind unless asked, then reads it from the worktree first", () =>
    Effect.gen(function* () {
      const worktreeThread = Option.some(
        threadDetail({ worktreePath: "/Users/dev/.t3/worktrees/uno/feat" } as never),
      );
      const withoutEnv = makeFixture({
        thread: worktreeThread,
        envFiles: { "/Users/dev/uno": "ROOT=1\n" },
      });
      const skipped = yield* makeThreadContinueSnapshot(withoutEnv.deps)({ threadId: THREAD_ID });
      assert.equal(skipped.envText, null);
      assert.deepEqual(withoutEnv.envReads, []);

      const fromWorktree = makeFixture({
        thread: worktreeThread,
        envFiles: {
          "/Users/dev/.t3/worktrees/uno/feat": "WT=1\n",
          "/Users/dev/uno": "ROOT=1\n",
        },
      });
      const worktreeEnv = yield* makeThreadContinueSnapshot(fromWorktree.deps)({
        threadId: THREAD_ID,
        includeEnv: true,
      });
      assert.equal(worktreeEnv.envText, "WT=1\n");

      const fallback = makeFixture({
        thread: worktreeThread,
        envFiles: { "/Users/dev/uno": "ROOT=1\n" },
      });
      const rootEnv = yield* makeThreadContinueSnapshot(fallback.deps)({
        threadId: THREAD_ID,
        includeEnv: true,
      });
      assert.equal(rootEnv.envText, "ROOT=1\n");
      assert.deepEqual(fallback.envReads, ["/Users/dev/.t3/worktrees/uno/feat", "/Users/dev/uno"]);
    }),
  );

  it.effect("makes a parentless snapshot in an unborn repository", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        transport: { readHead: () => Effect.succeed({ commit: null, branch: null }) },
      });
      const result = yield* makeThreadContinueSnapshot(fixture.deps)({ threadId: THREAD_ID });
      assert.deepEqual(
        callInput<{ parents: ReadonlyArray<string> }>(fixture.transportCalls, "captureSnapshot")
          .parents,
        [],
      );
      assert.equal(result.baseCommit, null);
    }),
  );

  it.effect("works without a remote: the target gets the whole history instead", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ transport: { resolveRemote: () => Effect.succeed(null) } });
      const result = yield* makeThreadContinueSnapshot(fixture.deps)({ threadId: THREAD_ID });
      assert.equal(result.remoteUrl, null);
    }),
  );

  it.effect("refuses a snapshot above the size limit and deletes the bundle", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        transfers: {
          digest: () =>
            Effect.succeed({ sizeBytes: THREAD_CONTINUE_MAX_BUNDLE_BYTES + 1, sha256: "x" }),
        },
      });
      const error = yield* expectFailure(
        makeThreadContinueSnapshot(fixture.deps)({ threadId: THREAD_ID }),
      );
      assert.equal(error.reason, "too_large");
      assert.include(ops(fixture.transferCalls), "discard");
    }),
  );

  it.effect("fails for non-git projects and missing threads, before touching the tree", () =>
    Effect.gen(function* () {
      const notGit = makeFixture({ transport: { isGitRepository: () => Effect.succeed(false) } });
      const notGitError = yield* expectFailure(
        makeThreadContinueSnapshot(notGit.deps)({ threadId: THREAD_ID }),
      );
      assert.equal(notGitError.reason, "not_git");
      assert.isFalse(ops(notGit.transportCalls).includes("captureSnapshot"));

      const missing = makeFixture({ thread: Option.none() });
      const missingError = yield* expectFailure(
        makeThreadContinueSnapshot(missing.deps)({ threadId: THREAD_ID }),
      );
      assert.equal(missingError.reason, "thread_not_found");
    }),
  );

  it.effect("still drops the hidden ref when bundling fails", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        transport: { createBundle: () => Effect.fail(new Error("disk full")) as never },
      });
      const error = yield* expectFailure(
        makeThreadContinueSnapshot(fixture.deps)({ threadId: THREAD_ID }),
      );
      assert.equal(error.reason, "capture_failed");
      assert.include(ops(fixture.transportCalls), "deleteRef");
    }),
  );
});

const landInput = (overrides: Partial<ThreadContinueLandInput> = {}): ThreadContinueLandInput => ({
  transferId: TRANSFER_ID,
  sizeBytes: DIGEST.sizeBytes,
  sha256: DIGEST.sha256,
  commit: "wipsha",
  baseCommit: "headsha",
  project: { kind: "existing", projectPath: "/Users/dev/uno" },
  title: "Fix login",
  modelSelection: CLAUDE_SELECTION,
  runtimeMode: "auto-accept-edits",
  interactionMode: "plan",
  seedText: "[Continued from Misha's Mac] seed",
  envText: null,
  sourceMachineLabel: "Misha's Mac",
  sourceThreadId: THREAD_ID,
  ...overrides,
});

describe("thread.continue.land", () => {
  it.effect(
    "verifies the bytes, opens a new worktree on uno/continue/<id> at the base commit and creates the thread there",
    () =>
      Effect.gen(function* () {
        const fixture = makeFixture();
        const result = yield* makeThreadContinueLand(fixture.deps)(
          landInput({ envText: "TOKEN=1\n" }),
        );

        const worktreePath = `${WORKTREES}/uno/uno-continue-thread-1`;
        assert.deepEqual(callInput(fixture.transportCalls, "verifyBundle"), {
          cwd: "/Users/dev/uno",
          bundlePath: `/scratch/incoming/${TRANSFER_ID}.bundle`,
        });
        assert.deepEqual(callInput(fixture.transportCalls, "fetchBundle"), {
          cwd: "/Users/dev/uno",
          bundlePath: `/scratch/incoming/${TRANSFER_ID}.bundle`,
          ref: CheckpointRef.make(TRANSFER_REF),
        });
        assert.deepEqual(callInput(fixture.transportCalls, "addWorktree"), {
          cwd: "/Users/dev/uno",
          branch: "uno/continue/thread-1",
          path: worktreePath,
          startPoint: "headsha",
        });
        // The files go into the new worktree, never into the project checkout.
        assert.deepEqual(callInput(fixture.transportCalls, "restoreTree"), {
          cwd: worktreePath,
          ref: CheckpointRef.make(TRANSFER_REF),
        });
        assert.isFalse(ops(fixture.transportCalls).includes("fetchRemotes"));
        assert.deepEqual(fixture.writtenEnv, [{ folder: worktreePath, text: "TOKEN=1\n" }]);
        assert.include(ops(fixture.transferCalls), "discard");
        assert.deepEqual(fixture.clones, []);

        assert.deepEqual(
          fixture.dispatched.map((entry) => entry.command.type),
          ["thread.create", "thread.message.user.append", "thread.activity.append"],
        );
        const create = fixture.dispatched[0]?.command;
        assert.equal(create?.type, "thread.create");
        if (create?.type === "thread.create") {
          assert.equal(create.projectId, PROJECT_ID);
          assert.equal(create.branch, "uno/continue/thread-1");
          assert.equal(create.worktreePath, worktreePath);
          assert.deepEqual(create.modelSelection, CLAUDE_SELECTION);
        }
        for (const entry of fixture.dispatched) {
          assert.deepEqual(entry.origin, {
            kind: "system",
            component: "thread-continue",
            reason: "continued from Misha's Mac",
          });
        }
        assert.deepEqual(result, {
          projectId: PROJECT_ID,
          threadId: result.threadId,
          projectPath: "/Users/dev/uno",
          worktreePath,
          branch: "uno/continue/thread-1",
          projectCreated: false,
          modelSelection: CLAUDE_SELECTION,
          modelFallbackApplied: false,
          envWritten: true,
        });
      }),
  );

  it.effect("refuses bytes that do not match the source's size or hash, before any git work", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        transfers: { digest: () => Effect.succeed({ sizeBytes: 10, sha256: "other" }) },
      });
      const error = yield* expectFailure(makeThreadContinueLand(fixture.deps)(landInput()));
      assert.equal(error.reason, "transfer_incomplete");
      assert.deepEqual(fixture.transportCalls, []);
      assert.equal(fixture.dispatched.length, 0);
    }),
  );

  it.effect("fetches from its own remotes when the base commit is missing, then continues", () =>
    Effect.gen(function* () {
      let verifications = 0;
      const fixture = makeFixture({
        transport: {
          verifyBundle: () =>
            Effect.sync(() => {
              verifications += 1;
              return verifications === 1
                ? { ok: false, detail: "Repository lacks these prerequisite commits" }
                : { ok: true, detail: "" };
            }),
        },
      });
      yield* makeThreadContinueLand(fixture.deps)(landInput());
      assert.deepEqual(ops(fixture.transportCalls).slice(0, 4), [
        "isGitRepository",
        "verifyBundle",
        "fetchRemotes",
        "verifyBundle",
      ]);
      assert.include(ops(fixture.transportCalls), "addWorktree");
    }),
  );

  it.effect("fails with base_missing when the base cannot be fetched either", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        transport: {
          verifyBundle: () => Effect.succeed({ ok: false, detail: "lacks prerequisite" }),
          fetchRemotes: () => Effect.fail(new Error("could not read from remote")) as never,
        },
      });
      const error = yield* expectFailure(makeThreadContinueLand(fixture.deps)(landInput()));
      assert.equal(error.reason, "base_missing");
      assert.include(error.message, "headsha".slice(0, 7));
      assert.isFalse(ops(fixture.transportCalls).includes("addWorktree"));
      assert.equal(fixture.dispatched.length, 0);
    }),
  );

  it.effect("refuses a bundle whose snapshot is not the reported commit", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ transport: { fetchBundle: () => Effect.succeed("othersha") } });
      const error = yield* expectFailure(makeThreadContinueLand(fixture.deps)(landInput()));
      assert.equal(error.reason, "commit_mismatch");
      assert.isFalse(ops(fixture.transportCalls).includes("addWorktree"));
    }),
  );

  it.effect("numbers the branch when an earlier continue already used the name", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        transport: {
          branchExists: ({ branch }) => Effect.succeed(branch === "uno/continue/thread-1"),
        },
        existingDirectories: new Set([`${WORKTREES}/uno/uno-continue-thread-1-2`]),
      });
      const result = yield* makeThreadContinueLand(fixture.deps)(landInput());
      assert.equal(result.branch, "uno/continue/thread-1-3");
      assert.equal(result.worktreePath, `${WORKTREES}/uno/uno-continue-thread-1-3`);
    }),
  );

  it.effect("starts the branch at the snapshot when the source repository was unborn", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      yield* makeThreadContinueLand(fixture.deps)(landInput({ baseCommit: null }));
      assert.equal(
        callInput<{ startPoint: string }>(fixture.transportCalls, "addWorktree").startPoint,
        "wipsha",
      );
      assert.isFalse(ops(fixture.transportCalls).includes("restoreTree"));
    }),
  );

  it.effect("resolves an existing project by path, expanding ~ and ignoring trailing slashes", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        projects: [projectShell({ workspaceRoot: "/home/unowork/projects/uno" })],
      });
      const result = yield* makeThreadContinueLand(fixture.deps)(
        landInput({ project: { kind: "existing", projectPath: "~/projects/uno/" } }),
      );
      assert.equal(result.projectPath, "/home/unowork/projects/uno");
    }),
  );

  it.effect("clones and registers the project when asked to create it", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ projects: [] });
      const result = yield* makeThreadContinueLand(fixture.deps)(
        landInput({
          project: {
            kind: "create",
            remoteUrl: "git@github.com:uno/uno.git",
            destinationPath: "~/projects/uno",
            title: "uno",
          },
        }),
      );
      assert.deepEqual(fixture.clones, [
        { remoteUrl: "git@github.com:uno/uno.git", destinationPath: "/home/unowork/projects/uno" },
      ]);
      assert.equal(fixture.dispatched[0]?.command.type, "project.create");
      assert.equal(result.projectCreated, true);
      assert.equal(result.projectPath, "/home/unowork/projects/uno");
      assert.equal(result.worktreePath, `${WORKTREES}/uno/uno-continue-thread-1`);
    }),
  );

  it.effect("starts an empty repository when the project has no remote", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ projects: [] });
      const result = yield* makeThreadContinueLand(fixture.deps)(
        landInput({
          project: {
            kind: "create",
            remoteUrl: null,
            destinationPath: "~/projects/uno",
            title: "uno",
          },
        }),
      );
      assert.deepEqual(fixture.clones, []);
      assert.deepEqual(fixture.madeDirectories, ["/home/unowork/projects/uno"]);
      assert.equal(
        callInput(fixture.transportCalls, "initRepository"),
        "/home/unowork/projects/uno",
      );
      assert.equal(result.projectCreated, true);
    }),
  );

  it.effect("adopts an existing clone at the destination instead of cloning again", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        projects: [],
        existingDirectories: new Set(["/home/unowork/projects/uno"]),
      });
      const result = yield* makeThreadContinueLand(fixture.deps)(
        landInput({
          project: {
            kind: "create",
            remoteUrl: "git@github.com:uno/uno.git",
            destinationPath: "~/projects/uno",
            title: "uno",
          },
        }),
      );
      assert.deepEqual(fixture.clones, []);
      assert.equal(result.projectCreated, true);
    }),
  );

  it.effect("refuses to use a folder that is not a repository", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        projects: [],
        existingDirectories: new Set(["/home/unowork/projects/uno"]),
        transport: { isGitRepository: () => Effect.succeed(false) },
      });
      const error = yield* expectFailure(
        makeThreadContinueLand(fixture.deps)(
          landInput({
            project: {
              kind: "create",
              remoteUrl: "git@github.com:uno/uno.git",
              destinationPath: "~/projects/uno",
              title: "uno",
            },
          }),
        ),
      );
      assert.equal(error.reason, "clone_failed");
      assert.equal(fixture.dispatched.length, 0);
    }),
  );

  it.effect("fails when no project is registered at the given path", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ projects: [] });
      const error = yield* expectFailure(makeThreadContinueLand(fixture.deps)(landInput()));
      assert.equal(error.reason, "project_not_found");
    }),
  );

  it.effect("falls back to a model this machine can run and says so in the seed", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ providers: [codex] });
      const result = yield* makeThreadContinueLand(fixture.deps)(landInput());
      assert.equal(result.modelFallbackApplied, true);
      assert.deepEqual(result.modelSelection, CODEX_SELECTION);
      const seed = fixture.dispatched[1]?.command;
      if (seed?.type === "thread.message.user.append") {
        assert.include(seed.text, "is not installed here");
      }
    }),
  );

  it.effect("fails with no_model before creating a branch or worktree", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ providers: [] });
      const error = yield* expectFailure(makeThreadContinueLand(fixture.deps)(landInput()));
      assert.equal(error.reason, "no_model");
      assert.isFalse(ops(fixture.transportCalls).includes("fetchBundle"));
      assert.isFalse(ops(fixture.transportCalls).includes("addWorktree"));
    }),
  );

  it.effect("keeps going when .env cannot be written, and skips it when not sent", () =>
    Effect.gen(function* () {
      const failing = makeFixture({ writeEnvFails: true });
      const result = yield* makeThreadContinueLand(failing.deps)(
        landInput({ envText: "TOKEN=1\n" }),
      );
      assert.equal(result.envWritten, false);

      const skipped = makeFixture();
      const skippedResult = yield* makeThreadContinueLand(skipped.deps)(landInput());
      assert.equal(skippedResult.envWritten, false);
      assert.deepEqual(skipped.writtenEnv, []);
    }),
  );
});

describe("legacy 0.0.53–0.0.56 RPCs", () => {
  it.effect("answer with an update request and never touch git", () =>
    Effect.gen(function* () {
      const error = yield* expectFailure(
        makeThreadContinueLegacyRefusal("thread.continue.prepare")({ threadId: THREAD_ID }),
      );
      assert.equal(error.reason, "invalid_request");
      assert.equal(error.message, THREAD_CONTINUE_LEGACY_CLIENT_MESSAGE);
    }),
  );
});

describe("thread.continue.inspect", () => {
  it.effect("reports a missing folder as a clone target", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ projects: [] });
      const result = yield* makeThreadContinueInspect(fixture.deps)({
        projectPath: "~/projects/uno",
      });
      assert.deepEqual(result, {
        projectPath: "/home/unowork/projects/uno",
        exists: false,
        isGitRepository: false,
        registered: false,
        hasLocalChanges: false,
        changedFiles: 0,
        branch: null,
      });
      assert.isFalse(ops(fixture.transportCalls).includes("readStatus"));
    }),
  );

  it.effect("flags a folder that exists but is not a repository, without reading status", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        projects: [],
        existingDirectories: new Set(["/home/unowork/projects/uno"]),
        transport: { isGitRepository: () => Effect.succeed(false) },
      });
      const result = yield* makeThreadContinueInspect(fixture.deps)({
        projectPath: "~/projects/uno",
      });
      assert.equal(result.exists, true);
      assert.equal(result.isGitRepository, false);
      assert.equal(result.hasLocalChanges, false);
      assert.isFalse(ops(fixture.transportCalls).includes("readStatus"));
    }),
  );

  it.effect("reports a clean registered checkout with its branch", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        existingDirectories: new Set(["/Users/dev/uno"]),
        transport: {
          readStatus: () => Effect.succeed({ commit: "headsha", branch: "main", changedFiles: 0 }),
        },
      });
      const result = yield* makeThreadContinueInspect(fixture.deps)({
        projectPath: "/Users/dev/uno/",
      });
      // The trailing slash is dropped, like `land` does, so the folder
      // inspected is the folder used.
      assert.deepEqual(result, {
        projectPath: "/Users/dev/uno",
        exists: true,
        isGitRepository: true,
        registered: true,
        hasLocalChanges: false,
        changedFiles: 0,
        branch: "main",
      });
      assert.equal(callInput<string>(fixture.transportCalls, "readStatus"), "/Users/dev/uno");
    }),
  );

  it.effect("counts local changes in the checkout, for information only", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        existingDirectories: new Set(["/Users/dev/uno"]),
        transport: {
          readStatus: () => Effect.succeed({ commit: "headsha", branch: null, changedFiles: 4 }),
        },
      });
      const result = yield* makeThreadContinueInspect(fixture.deps)({
        projectPath: "/Users/dev/uno",
      });
      assert.equal(result.hasLocalChanges, true);
      assert.equal(result.changedFiles, 4);
      assert.equal(result.branch, null);
      // Read-only: nothing is dispatched or written.
      assert.equal(fixture.dispatched.length, 0);
      assert.deepEqual(fixture.writtenEnv, []);
    }),
  );
});

describe("thread.continue.complete", () => {
  it.effect("marks the source thread and archives it on request", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const complete = makeThreadContinueComplete(fixture.deps);

      const marked = yield* complete({
        threadId: THREAD_ID,
        targetMachineLabel: "box-1",
        targetThreadId: ThreadId.make("thread-2"),
      });
      assert.equal(marked.archived, false);
      assert.deepEqual(
        fixture.dispatched.map((entry) => entry.command.type),
        ["thread.activity.append"],
      );
      const activity = fixture.dispatched[0]?.command;
      if (activity?.type === "thread.activity.append") {
        assert.equal(activity.activity.kind, "thread.continued.on");
        assert.equal(activity.activity.summary, "Continued on box-1 as thread-2");
      }

      const archived = yield* complete({
        threadId: THREAD_ID,
        targetMachineLabel: "box-1",
        targetThreadId: ThreadId.make("thread-2"),
        archive: true,
      });
      assert.equal(archived.archived, true);
      assert.equal(fixture.dispatched.at(-1)?.command.type, "thread.archive");
    }),
  );

  it.effect("does not archive a thread whose turn is still running", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        threadShell: Option.some(
          threadShell({
            session: { status: "running", activeTurnId: "turn-9" } as never,
          }),
        ),
      });
      const result = yield* makeThreadContinueComplete(fixture.deps)({
        threadId: THREAD_ID,
        targetMachineLabel: "box-1",
        targetThreadId: ThreadId.make("thread-2"),
        archive: true,
      });
      assert.equal(result.archived, false);
      assert.isFalse(fixture.dispatched.some((entry) => entry.command.type === "thread.archive"));
    }),
  );

  it.effect("fails when the thread is gone", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ threadShell: Option.none() });
      const error = yield* expectFailure(
        makeThreadContinueComplete(fixture.deps)({
          threadId: THREAD_ID,
          targetMachineLabel: "box-1",
          targetThreadId: ThreadId.make("thread-2"),
        }),
      );
      assert.equal(error.reason, "thread_not_found");
    }),
  );
});

describe("resolveTargetModelSelection", () => {
  it("keeps the requested model when its harness is installed", () => {
    assert.deepEqual(
      resolveTargetModelSelection({
        requested: CLAUDE_SELECTION,
        projectDefault: CODEX_SELECTION,
        providers: [codex, claude],
      }),
      { selection: CLAUDE_SELECTION, fallbackApplied: false },
    );
  });

  it("prefers the project default, then whatever the machine can run", () => {
    assert.deepEqual(
      resolveTargetModelSelection({
        requested: CLAUDE_SELECTION,
        projectDefault: CODEX_SELECTION,
        providers: [codex],
      }),
      { selection: CODEX_SELECTION, fallbackApplied: true },
    );
    assert.deepEqual(
      resolveTargetModelSelection({
        requested: CLAUDE_SELECTION,
        projectDefault: null,
        providers: [codex],
      }),
      { selection: CODEX_SELECTION, fallbackApplied: true },
    );
    assert.deepEqual(
      resolveTargetModelSelection({
        requested: undefined,
        projectDefault: null,
        providers: [codex],
      }),
      { selection: CODEX_SELECTION, fallbackApplied: false },
    );
    assert.equal(
      resolveTargetModelSelection({
        requested: CLAUDE_SELECTION,
        projectDefault: null,
        providers: [],
      }),
      null,
    );
  });
});
