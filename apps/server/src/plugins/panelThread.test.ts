import type {
  OrchestrationCommand,
  OrchestrationCommandOrigin,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  PluginManifest,
  ProjectId,
  ServerPluginRun,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { describe } from "vitest";

import {
  makePanelThreadResolver,
  makePanelThreadSender,
  type PanelThreadSenderDeps,
} from "./panelThread.ts";
import type { LoadedPlugin } from "./PluginRegistry.ts";

const PROJECT_ID = "project-1" as ProjectId;

const manifest = (overrides: Partial<PluginManifest> = {}): PluginManifest =>
  ({
    name: "Deploys",
    enabled: true,
    hooks: [],
    crons: [],
    panel: { title: "Deploys", path: "panel/index.html" },
    ...overrides,
  }) as PluginManifest;

const loadedPlugin = (overrides: Partial<LoadedPlugin> = {}): LoadedPlugin => ({
  id: "deploys",
  fileName: "deploys/plugin.json",
  filePath: "/tmp/plugins/deploys/plugin.json",
  directoryPath: "/tmp/plugins/deploys",
  manifest: manifest(),
  error: undefined,
  ...overrides,
});

const projectShell = (
  overrides: Partial<OrchestrationProjectShell> = {},
): OrchestrationProjectShell =>
  ({
    id: PROJECT_ID,
    title: "Uno Work",
    workspaceRoot: "/Users/dev/uno",
    defaultModelSelection: { instanceId: "codex", modelId: "gpt-5" },
    scripts: [],
    createdAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T09:00:00.000Z",
    ...overrides,
  }) as unknown as OrchestrationProjectShell;

const threadShell = (overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell =>
  ({
    id: "thread-existing" as ThreadId,
    projectId: PROJECT_ID,
    title: "[Deploys] panel",
    modelSelection: { instanceId: "codex", modelId: "gpt-5" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T09:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

interface Fixture {
  readonly deps: PanelThreadSenderDeps;
  readonly dispatched: Array<{
    readonly command: OrchestrationCommand;
    readonly origin: OrchestrationCommandOrigin | undefined;
  }>;
  readonly runs: ServerPluginRun[];
  readonly panelThreads: Map<string, ThreadId>;
}

function makeFixture(options?: {
  readonly plugins?: ReadonlyArray<LoadedPlugin>;
  readonly project?: Option.Option<OrchestrationProjectShell>;
  readonly threadsById?: ReadonlyMap<string, OrchestrationThreadShell>;
  readonly firstThreadId?: Option.Option<ThreadId>;
  readonly panelThreads?: Map<string, ThreadId>;
}): Fixture {
  const dispatched: Fixture["dispatched"] = [];
  const runs: ServerPluginRun[] = [];
  const panelThreads = options?.panelThreads ?? new Map<string, ThreadId>();
  const threadsById = options?.threadsById ?? new Map<string, OrchestrationThreadShell>();

  const deps: PanelThreadSenderDeps = {
    registry: {
      getLoadedPlugins: Effect.succeed(options?.plugins ?? [loadedPlugin()]),
      getPanelThreadId: ({ pluginId, threadTag }) =>
        Effect.sync(() => panelThreads.get(`${pluginId}/${threadTag}`)),
      setPanelThreadId: ({ pluginId, threadTag, threadId }) =>
        Effect.sync(() => {
          panelThreads.set(`${pluginId}/${threadTag}`, threadId);
        }),
      recordRun: (_pluginId, run) =>
        Effect.sync(() => {
          runs.push(run);
        }),
    },
    engine: {
      dispatch: (command, dispatchOptions) =>
        Effect.sync(() => {
          dispatched.push({ command, origin: dispatchOptions?.origin });
          return { sequence: dispatched.length };
        }),
    },
    projections: {
      getProjectShellById: () => Effect.succeed(options?.project ?? Option.some(projectShell())),
      getThreadShellById: (threadId) =>
        Effect.succeed(Option.fromNullishOr(threadsById.get(threadId))),
      getFirstActiveThreadIdByProjectId: () =>
        Effect.succeed(options?.firstThreadId ?? Option.none<ThreadId>()),
    },
  };

  return { deps, dispatched, runs, panelThreads };
}

describe("plugins.sendToThread", () => {
  it.effect("creates a thread stamped with the plugin origin and starts a turn", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();
      const send = makePanelThreadSender(fixture.deps);

      const result = yield* send({
        pluginId: "deploys",
        projectId: PROJECT_ID,
        text: "  задеплой прод  ",
      });

      assert.equal(result.created, true);
      assert.equal(result.pluginName, "Deploys");
      assert.equal(result.threadTag, "panel");

      assert.equal(fixture.dispatched.length, 2);
      const [create, turn] = fixture.dispatched;
      assert.equal(create!.command.type, "thread.create");
      assert.deepEqual(create!.origin, { kind: "plugin", pluginId: "deploys" });
      assert.deepEqual(turn!.origin, { kind: "plugin", pluginId: "deploys" });
      if (create!.command.type !== "thread.create") throw new Error("unreachable");
      assert.equal(create!.command.title, "[Deploys] panel");
      assert.equal(create!.command.projectId, PROJECT_ID);
      // Наследовать не от чего → самый узкий режим, а не full-access.
      assert.equal(create!.command.runtimeMode, "approval-required");
      if (turn!.command.type !== "thread.turn.start") throw new Error("unreachable");
      assert.equal(turn!.command.message.text, "задеплой прод");
      assert.equal(turn!.command.threadId, create!.command.threadId);

      // Запуск виден в Settings → Extensions.
      assert.equal(fixture.runs.length, 1);
      assert.equal(fixture.runs[0]!.trigger, "panel sendToThread");
      assert.equal(fixture.runs[0]!.ok, true);
      assert.equal(fixture.panelThreads.get("deploys/panel"), result.threadId);
    }),
  );

  it.effect("inherits runtime/interaction mode from the project's first thread", () =>
    Effect.gen(function* () {
      const first = threadShell({
        id: "thread-first" as ThreadId,
        runtimeMode: "auto-accept-edits",
        interactionMode: "plan",
      });
      const fixture = makeFixture({
        firstThreadId: Option.some("thread-first" as ThreadId),
        threadsById: new Map([["thread-first", first]]),
      });

      yield* makePanelThreadSender(fixture.deps)({
        pluginId: "deploys",
        projectId: PROJECT_ID,
        text: "проверь сборку",
      });

      const create = fixture.dispatched[0]!.command;
      if (create.type !== "thread.create") throw new Error("unreachable");
      assert.equal(create.runtimeMode, "auto-accept-edits");
      assert.equal(create.interactionMode, "plan");
    }),
  );

  it.effect("reuses a live thread for the same threadTag", () =>
    Effect.gen(function* () {
      const existing = threadShell({ id: "thread-existing" as ThreadId });
      const fixture = makeFixture({
        panelThreads: new Map([["deploys/release", "thread-existing" as ThreadId]]),
        threadsById: new Map([["thread-existing", existing]]),
      });
      const send = makePanelThreadSender(fixture.deps);

      const result = yield* send({
        pluginId: "deploys",
        projectId: PROJECT_ID,
        text: "ещё раз",
        threadTag: "release",
      });

      assert.equal(result.created, false);
      assert.equal(result.threadId, "thread-existing");
      assert.equal(fixture.dispatched.length, 1);
      const [turn] = fixture.dispatched;
      assert.equal(turn!.command.type, "thread.turn.start");
      if (turn!.command.type !== "thread.turn.start") throw new Error("unreachable");
      // Права переиспользуемого треда не меняются.
      assert.equal(turn!.command.runtimeMode, "auto-accept-edits");
    }),
  );

  it.effect("starts a new thread when the mapped thread is gone or archived", () =>
    Effect.gen(function* () {
      const archived = threadShell({
        id: "thread-archived" as ThreadId,
        archivedAt: "2026-08-24T10:00:00.000Z",
      });
      const fixture = makeFixture({
        panelThreads: new Map([["deploys/panel", "thread-archived" as ThreadId]]),
        threadsById: new Map([["thread-archived", archived]]),
      });
      const send = makePanelThreadSender(fixture.deps);

      const result = yield* send({ pluginId: "deploys", projectId: PROJECT_ID, text: "снова" });

      assert.equal(result.created, true);
      assert.notEqual(result.threadId, "thread-archived");
      assert.equal(fixture.dispatched.length, 2);
    }),
  );

  it.effect("refuses panels of disabled plugins, empty text and missing projects", () =>
    Effect.gen(function* () {
      const disabled = makeFixture({
        plugins: [loadedPlugin({ manifest: manifest({ enabled: false }) })],
      });
      const disabledError = yield* Effect.flip(
        makePanelThreadSender(disabled.deps)({
          pluginId: "deploys",
          projectId: PROJECT_ID,
          text: "привет",
        }),
      );
      assert.include(disabledError.detail, "no enabled panel");
      assert.equal(disabled.dispatched.length, 0);

      const empty = makeFixture();
      const emptyError = yield* Effect.flip(
        makePanelThreadSender(empty.deps)({
          pluginId: "deploys",
          projectId: PROJECT_ID,
          text: "   ",
        }),
      );
      assert.include(emptyError.detail, "text must not be empty");

      const noProject = makeFixture({ project: Option.none() });
      const projectError = yield* Effect.flip(
        makePanelThreadSender(noProject.deps)({
          pluginId: "deploys",
          projectId: PROJECT_ID,
          text: "привет",
        }),
      );
      assert.include(projectError.detail, "no longer exists");
      assert.equal(noProject.dispatched.length, 0);
    }),
  );
});

describe("plugins.resolvePanelThread", () => {
  it.effect("creates the panel thread without starting a turn", () =>
    Effect.gen(function* () {
      const fixture = makeFixture();

      const result = yield* makePanelThreadResolver(fixture.deps)({
        pluginId: "deploys",
        projectId: PROJECT_ID,
        threadTag: "assistant",
      });

      assert.equal(result.created, true);
      assert.equal(result.threadTag, "assistant");
      assert.equal(result.pluginName, "Deploys");
      // Ровно одна команда: тред создан, ход НЕ запущен.
      assert.equal(fixture.dispatched.length, 1);
      const [create] = fixture.dispatched;
      assert.equal(create!.command.type, "thread.create");
      assert.deepEqual(create!.origin, { kind: "plugin", pluginId: "deploys" });
      if (create!.command.type !== "thread.create") throw new Error("unreachable");
      assert.equal(create!.command.title, "[Deploys] assistant");
      // Наследовать не от чего → самый узкий режим.
      assert.equal(create!.command.runtimeMode, "approval-required");
      assert.equal(fixture.panelThreads.get("deploys/assistant"), result.threadId);
    }),
  );

  it.effect("shares one mapping with sendToThread in both directions", () =>
    Effect.gen(function* () {
      // 1) Чат резолвит тред → sendToThread обязан попасть в него же.
      const threadsById = new Map<string, OrchestrationThreadShell>();
      const first = makeFixture({ threadsById });
      const resolved = yield* makePanelThreadResolver(first.deps)({
        pluginId: "deploys",
        projectId: PROJECT_ID,
        threadTag: "assistant",
      });
      // Созданный тред теперь живой — как его увидит следующий вызов.
      threadsById.set(resolved.threadId, threadShell({ id: resolved.threadId }));

      const sent = yield* makePanelThreadSender(first.deps)({
        pluginId: "deploys",
        projectId: PROJECT_ID,
        text: "привет",
        threadTag: "assistant",
      });
      assert.equal(sent.created, false);
      assert.equal(sent.threadId, resolved.threadId);

      // 2) И наоборот: тред, созданный sendToThread, переиспользует чат.
      const existing = threadShell({ id: "thread-existing" as ThreadId });
      const second = makeFixture({
        panelThreads: new Map([["deploys/panel", "thread-existing" as ThreadId]]),
        threadsById: new Map([["thread-existing", existing]]),
      });
      const reused = yield* makePanelThreadResolver(second.deps)({
        pluginId: "deploys",
        projectId: PROJECT_ID,
      });
      assert.equal(reused.created, false);
      assert.equal(reused.threadId, "thread-existing");
      assert.equal(second.dispatched.length, 0);
    }),
  );

  it.effect("refuses panels of disabled plugins", () =>
    Effect.gen(function* () {
      const disabled = makeFixture({
        plugins: [loadedPlugin({ manifest: manifest({ enabled: false }) })],
      });
      const error = yield* Effect.flip(
        makePanelThreadResolver(disabled.deps)({ pluginId: "deploys", projectId: PROJECT_ID }),
      );
      assert.include(error.detail, "no enabled panel");
      assert.equal(disabled.dispatched.length, 0);
    }),
  );
});
