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
  ThreadContinueError,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { describe } from "vitest";

import type { ContinueTransportShape } from "../git/continueTransport.ts";
import {
  continueBranchForThread,
  type ContinueOnMachineDeps,
  makeThreadContinueComplete,
  makeThreadContinuePrepare,
  makeThreadContinueReceive,
  NO_REMOTE_MESSAGE,
  resolveTargetModelSelection,
  threadIdFromContinueBranch,
} from "./continueOnMachine.ts";
import { CONTINUE_SEED_PREFIX, HANDOFF_PREAMBLE_START } from "./handoff.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const NOW = "2026-09-12T10:00:00.000Z";

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

interface TransportCall {
  readonly op: keyof ContinueTransportShape;
  readonly input: unknown;
}

interface Fixture {
  readonly deps: ContinueOnMachineDeps;
  readonly dispatched: Array<{
    readonly command: OrchestrationCommand;
    readonly origin: OrchestrationCommandOrigin | undefined;
  }>;
  readonly transportCalls: TransportCall[];
  readonly writtenEnv: Array<{ readonly root: string; readonly text: string }>;
  readonly clones: Array<{ readonly remoteUrl: string; readonly destinationPath: string }>;
}

function makeFixture(options?: {
  readonly thread?: Option.Option<OrchestrationThread>;
  readonly threadShell?: Option.Option<OrchestrationThreadShell>;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly transport?: Partial<ContinueTransportShape>;
  readonly envText?: string | null;
  readonly existingDirectories?: ReadonlySet<string>;
  readonly writeEnvFails?: boolean;
}): Fixture {
  const dispatched: Fixture["dispatched"] = [];
  const transportCalls: TransportCall[] = [];
  const writtenEnv: Fixture["writtenEnv"] = [];
  const clones: Fixture["clones"] = [];
  const projects = [...(options?.projects ?? [projectShell()])];

  const record =
    <K extends keyof ContinueTransportShape>(op: K, impl: ContinueTransportShape[K]) =>
    (...args: Parameters<ContinueTransportShape[K]>) => {
      transportCalls.push({ op, input: args.length === 1 ? args[0] : args });
      return (impl as (...inner: unknown[]) => ReturnType<ContinueTransportShape[K]>)(...args);
    };

  const baseTransport: ContinueTransportShape = {
    isGitRepository: () => Effect.succeed(true),
    resolveRemote: (_cwd, name) =>
      Effect.succeed({ name: name ?? "origin", url: "git@github.com:uno/uno.git" }),
    readHead: () => Effect.succeed({ commit: "headsha", branch: "feat/login" }),
    captureSnapshot: () => Effect.succeed("wipsha"),
    pushRef: () => Effect.void,
    fetchBranch: () => Effect.succeed("wipsha"),
    restoreTree: () => Effect.succeed(true),
    deleteRef: () => Effect.void,
  };
  const merged: ContinueTransportShape = { ...baseTransport, ...options?.transport };
  const transport = Object.fromEntries(
    (Object.keys(merged) as Array<keyof ContinueTransportShape>).map((op) => [
      op,
      record(op, merged[op]),
    ]),
  ) as unknown as ContinueTransportShape;

  const deps: ContinueOnMachineDeps = {
    transport,
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
    readEnvFile: () =>
      Effect.succeed(options?.envText === undefined ? "TOKEN=1\n" : options.envText),
    writeEnvFile: (root, text) =>
      options?.writeEnvFails
        ? Effect.fail(new Error("disk full"))
        : Effect.sync(() => {
            writtenEnv.push({ root, text });
          }),
    cloneRepository: (input) =>
      Effect.sync(() => {
        clones.push(input);
        return { cwd: input.destinationPath };
      }),
    directoryExists: (path) => Effect.succeed(options?.existingDirectories?.has(path) ?? false),
    expandPath: (path) => path.replace(/^~/, "/home/unowork"),
    now: () => NOW,
  };

  return { deps, dispatched, transportCalls, writtenEnv, clones };
}

const expectFailure = <A>(effect: Effect.Effect<A, ThreadContinueError>) => Effect.flip(effect);

function transportInput<T>(fixture: Fixture, op: keyof ContinueTransportShape): T {
  const call = fixture.transportCalls.find((candidate) => candidate.op === op);
  if (!call) {
    assert.fail(`expected a ${op} transport call`);
  }
  return call.input as T;
}

describe("transport branch naming", () => {
  it("maps a thread id to uno/continue/<threadId> and back", () => {
    assert.equal(continueBranchForThread("abc-123"), "uno/continue/abc-123");
    assert.equal(threadIdFromContinueBranch("uno/continue/abc-123"), "abc-123");
    assert.equal(threadIdFromContinueBranch("uno/continue/"), null);
    assert.equal(threadIdFromContinueBranch("main"), null);
  });
});

describe("thread.continue.prepare", () => {
  it.effect(
    "snapshots the working tree on top of HEAD, pushes the transport branch and builds the seed",
    () =>
      Effect.gen(function* () {
        const fixture = makeFixture();
        const prepare = makeThreadContinuePrepare(fixture.deps);

        const result = yield* prepare({ threadId: THREAD_ID });

        assert.equal(result.branch, "uno/continue/thread-1");
        assert.equal(result.commit, "wipsha");
        assert.equal(result.baseCommit, "headsha");
        assert.equal(result.sourceBranch, "feat/login");
        assert.equal(result.remoteName, "origin");
        assert.equal(result.remoteUrl, "git@github.com:uno/uno.git");
        assert.equal(result.sourceMachineLabel, "Misha's Mac");
        assert.equal(result.title, "Fix login");
        assert.deepEqual(result.modelSelection, CLAUDE_SELECTION);
        assert.equal(result.runtimeMode, "auto-accept-edits");
        assert.equal(result.interactionMode, "plan");
        assert.equal(result.envText, "TOKEN=1\n");
        assert.isTrue(result.seedText.startsWith(`${CONTINUE_SEED_PREFIX}Misha's Mac]`));
        assert.include(result.seedText, HANDOFF_PREAMBLE_START);
        assert.include(result.seedText, "User: please fix login\nAssistant: done, see auth.ts");

        const capture = fixture.transportCalls.find((call) => call.op === "captureSnapshot");
        assert.deepEqual(capture?.input, {
          cwd: "/Users/dev/uno",
          ref: CheckpointRef.make("refs/t3/continue/thread-1"),
          parents: ["headsha"],
          message: "uno continue: Fix login",
        });
        const push = fixture.transportCalls.find((call) => call.op === "pushRef");
        assert.deepEqual(push?.input, {
          cwd: "/Users/dev/uno",
          remoteName: "origin",
          localRef: "refs/t3/continue/thread-1",
          remoteBranch: "uno/continue/thread-1",
        });
        // The local ref is dropped once the remote holds the snapshot.
        assert.isTrue(fixture.transportCalls.some((call) => call.op === "deleteRef"));
        // Nothing is dispatched on the source until `complete`.
        assert.equal(fixture.dispatched.length, 0);
      }),
  );

  it.effect(
    "snapshots the thread's worktree rather than the project root, and honours the remote override",
    () =>
      Effect.gen(function* () {
        const fixture = makeFixture({
          thread: Option.some(threadDetail({ worktreePath: "/Users/dev/uno-wt" })),
        });
        const prepare = makeThreadContinuePrepare(fixture.deps);

        const result = yield* prepare({ threadId: THREAD_ID, remote: "uno", includeEnv: false });

        assert.equal(result.remoteName, "uno");
        assert.equal(result.envText, null);
        const capture = transportInput<{ cwd: string }>(fixture, "captureSnapshot");
        assert.equal(capture.cwd, "/Users/dev/uno-wt");
      }),
  );

  it.effect("makes a parentless snapshot in an unborn repository", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        transport: { readHead: () => Effect.succeed({ commit: null, branch: null }) },
      });
      const result = yield* makeThreadContinuePrepare(fixture.deps)({ threadId: THREAD_ID });
      assert.equal(result.baseCommit, null);
      assert.equal(result.sourceBranch, null);
      const capture = transportInput<{ parents: string[] }>(fixture, "captureSnapshot");
      assert.deepEqual(capture.parents, []);
    }),
  );

  it.effect("fails early without a remote, before touching the tree", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ transport: { resolveRemote: () => Effect.succeed(null) } });
      const error = yield* expectFailure(
        makeThreadContinuePrepare(fixture.deps)({ threadId: THREAD_ID }),
      );
      assert.equal(error.reason, "no_remote");
      assert.equal(error.message, NO_REMOTE_MESSAGE);
      assert.isFalse(fixture.transportCalls.some((call) => call.op === "captureSnapshot"));
    }),
  );

  it.effect("fails for non-git projects and missing threads", () =>
    Effect.gen(function* () {
      const notGit = makeFixture({ transport: { isGitRepository: () => Effect.succeed(false) } });
      const notGitError = yield* expectFailure(
        makeThreadContinuePrepare(notGit.deps)({ threadId: THREAD_ID }),
      );
      assert.equal(notGitError.reason, "not_git");

      const missing = makeFixture({ thread: Option.none() });
      const missingError = yield* expectFailure(
        makeThreadContinuePrepare(missing.deps)({ threadId: THREAD_ID }),
      );
      assert.equal(missingError.reason, "thread_not_found");
    }),
  );

  it.effect("reports a push failure with the remote name", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        transport: {
          pushRef: () => Effect.fail(new Error("Permission denied (publickey)")) as never,
        },
      });
      const error = yield* expectFailure(
        makeThreadContinuePrepare(fixture.deps)({ threadId: THREAD_ID }),
      );
      assert.equal(error.reason, "push_failed");
      assert.include(error.message, "origin");
      assert.include(error.message, "Permission denied");
    }),
  );
});

const receiveInput = (
  overrides: Partial<Parameters<ReturnType<typeof makeThreadContinueReceive>>[0]> = {},
) => ({
  project: { kind: "existing" as const, projectPath: "/Users/dev/uno/" },
  remoteUrl: "git@github.com:uno/uno.git",
  branch: "uno/continue/thread-1",
  commit: "wipsha",
  title: "Fix login",
  modelSelection: CLAUDE_SELECTION,
  runtimeMode: "auto-accept-edits" as const,
  interactionMode: "plan" as const,
  seedText: `${CONTINUE_SEED_PREFIX}Misha's Mac] seed`,
  envText: "TOKEN=1\n",
  sourceMachineLabel: "Misha's Mac",
  sourceThreadId: THREAD_ID,
  ...overrides,
});

describe("thread.continue.receive", () => {
  it.effect(
    "fetches into a hidden ref, restores the tree, writes .env and creates the seeded thread",
    () =>
      Effect.gen(function* () {
        const fixture = makeFixture();
        const receive = makeThreadContinueReceive(fixture.deps);

        const result = yield* receive(receiveInput());

        assert.equal(result.projectId, PROJECT_ID);
        assert.equal(result.projectPath, "/Users/dev/uno");
        assert.equal(result.projectCreated, false);
        assert.equal(result.envWritten, true);
        assert.equal(result.modelFallbackApplied, false);
        assert.deepEqual(result.modelSelection, CLAUDE_SELECTION);

        const fetch = fixture.transportCalls.find((call) => call.op === "fetchBranch");
        assert.deepEqual(fetch?.input, {
          cwd: "/Users/dev/uno",
          remoteUrl: "git@github.com:uno/uno.git",
          remoteBranch: "uno/continue/thread-1",
          localRef: "refs/t3/continue/thread-1",
        });
        const restore = fixture.transportCalls.find((call) => call.op === "restoreTree");
        assert.deepEqual(restore?.input, {
          cwd: "/Users/dev/uno",
          ref: "refs/t3/continue/thread-1",
        });
        assert.deepEqual(fixture.writtenEnv, [{ root: "/Users/dev/uno", text: "TOKEN=1\n" }]);

        assert.deepEqual(
          fixture.dispatched.map((entry) => entry.command.type),
          ["thread.create", "thread.message.user.append", "thread.activity.append"],
        );
        const create = fixture.dispatched[0]?.command;
        assert.equal(create?.type, "thread.create");
        if (create?.type === "thread.create") {
          assert.equal(create.threadId, result.threadId);
          assert.equal(create.title, "Fix login");
          assert.equal(create.runtimeMode, "auto-accept-edits");
          assert.equal(create.interactionMode, "plan");
          assert.equal(create.branch, null);
          assert.equal(create.worktreePath, null);
        }
        const seed = fixture.dispatched[1]?.command;
        if (seed?.type === "thread.message.user.append") {
          assert.equal(seed.text, `${CONTINUE_SEED_PREFIX}Misha's Mac] seed`);
        }
        const activity = fixture.dispatched[2]?.command;
        if (activity?.type === "thread.activity.append") {
          assert.equal(activity.activity.kind, "thread.continued.from");
          assert.equal(activity.activity.summary, "Continued from Misha's Mac");
        }
        // No turn is started: the person types the next message.
        assert.isFalse(
          fixture.dispatched.some((entry) => entry.command.type === "thread.turn.start"),
        );
        for (const entry of fixture.dispatched) {
          assert.deepEqual(entry.origin, {
            kind: "system",
            component: "thread-continue",
            reason: "continued from Misha's Mac",
          });
        }
      }),
  );

  it.effect("resolves an existing project by path, expanding ~ and ignoring trailing slashes", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        projects: [projectShell({ workspaceRoot: "/home/unowork/projects/uno" })],
      });
      const result = yield* makeThreadContinueReceive(fixture.deps)(
        receiveInput({ project: { kind: "existing", projectPath: "~/projects/uno/" } }),
      );
      assert.equal(result.projectPath, "/home/unowork/projects/uno");
      assert.equal(result.projectCreated, false);
    }),
  );

  it.effect("clones and registers the project when asked to create it", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ projects: [] });
      const result = yield* makeThreadContinueReceive(fixture.deps)(
        receiveInput({
          project: {
            kind: "create",
            remoteUrl: "git@github.com:uno/uno.git",
            destinationPath: "~/projects/uno",
            title: "uno",
          },
        }),
      );
      assert.equal(result.projectCreated, true);
      assert.equal(result.projectPath, "/home/unowork/projects/uno");
      assert.deepEqual(fixture.clones, [
        { remoteUrl: "git@github.com:uno/uno.git", destinationPath: "/home/unowork/projects/uno" },
      ]);
      assert.equal(fixture.dispatched[0]?.command.type, "project.create");
      const create = fixture.dispatched[0]?.command;
      if (create?.type === "project.create") {
        assert.equal(create.projectId, result.projectId);
        assert.equal(create.workspaceRoot, "/home/unowork/projects/uno");
        assert.equal(create.createWorkspaceRootIfMissing, true);
      }
    }),
  );

  it.effect("adopts an existing clone at the destination instead of cloning again", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        projects: [],
        existingDirectories: new Set(["/home/unowork/projects/uno"]),
      });
      const result = yield* makeThreadContinueReceive(fixture.deps)(
        receiveInput({
          project: {
            kind: "create",
            remoteUrl: "git@github.com:uno/uno.git",
            destinationPath: "~/projects/uno",
            title: "uno",
          },
        }),
      );
      assert.equal(result.projectCreated, true);
      assert.deepEqual(fixture.clones, []);
    }),
  );

  it.effect("refuses to clone over a folder that is not a repository", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        projects: [],
        existingDirectories: new Set(["/home/unowork/projects/uno"]),
        transport: { isGitRepository: () => Effect.succeed(false) },
      });
      const error = yield* expectFailure(
        makeThreadContinueReceive(fixture.deps)(
          receiveInput({
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
      const fixture = makeFixture();
      const error = yield* expectFailure(
        makeThreadContinueReceive(fixture.deps)(
          receiveInput({ project: { kind: "existing", projectPath: "/elsewhere" } }),
        ),
      );
      assert.equal(error.reason, "project_not_found");
      assert.isFalse(fixture.transportCalls.some((call) => call.op === "fetchBranch"));
    }),
  );

  it.effect("refuses a transport branch that no longer points at the pushed commit", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ transport: { fetchBranch: () => Effect.succeed("othersha") } });
      const error = yield* expectFailure(makeThreadContinueReceive(fixture.deps)(receiveInput()));
      assert.equal(error.reason, "commit_mismatch");
      assert.isFalse(fixture.transportCalls.some((call) => call.op === "restoreTree"));
      assert.equal(fixture.dispatched.length, 0);
    }),
  );

  it.effect("falls back to a model this machine can run and says so in the seed", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({
        providers: [
          codex,
          provider({ instanceId: "claudeAgent", driver: "claude", installed: false }),
        ],
        projects: [projectShell({ defaultModelSelection: CODEX_SELECTION })],
      });
      const result = yield* makeThreadContinueReceive(fixture.deps)(receiveInput());
      assert.equal(result.modelFallbackApplied, true);
      assert.deepEqual(result.modelSelection, CODEX_SELECTION);
      const seed = fixture.dispatched[1]?.command;
      if (seed?.type === "thread.message.user.append") {
        assert.include(seed.text, "claudeAgent / claude-sonnet-4-6");
        assert.include(seed.text, `codex / ${DEFAULT_MODEL}`);
      }
    }),
  );

  it.effect("fails with no_model when nothing on the machine can run a chat", () =>
    Effect.gen(function* () {
      const fixture = makeFixture({ providers: [] });
      const error = yield* expectFailure(makeThreadContinueReceive(fixture.deps)(receiveInput()));
      assert.equal(error.reason, "no_model");
      assert.equal(fixture.dispatched.length, 0);
    }),
  );

  it.effect("keeps going when .env cannot be written, and skips it when not sent", () =>
    Effect.gen(function* () {
      const failing = makeFixture({ writeEnvFails: true });
      const failed = yield* makeThreadContinueReceive(failing.deps)(receiveInput());
      assert.equal(failed.envWritten, false);
      assert.equal(failing.dispatched.length, 3);

      const skipped = makeFixture();
      const result = yield* makeThreadContinueReceive(skipped.deps)(
        receiveInput({ envText: null }),
      );
      assert.equal(result.envWritten, false);
      assert.deepEqual(skipped.writtenEnv, []);
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
