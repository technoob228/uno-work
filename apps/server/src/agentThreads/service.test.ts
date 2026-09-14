import {
  type OrchestrationCommand,
  type OrchestrationCommandOrigin,
  type OrchestrationMessage,
  type OrchestrationProject,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { describe } from "vitest";

import type { BridgeAuthorization } from "../browserBridge.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import type { OrchestrationDispatchError } from "../orchestration/Errors.ts";
import { HUMAN_IN_CONTROL_MESSAGE } from "./logic.ts";
import { type AgentThreadsScope, makeAgentThreadsHandlers } from "./service.ts";

const OWN_PROJECT = "project-own" as ProjectId;
const OTHER_PROJECT = "project-other" as ProjectId;
const CALLER = "thread-caller" as ThreadId;
const CHILD = "thread-child" as ThreadId;
const FOREIGN = "thread-foreign" as ThreadId;
const T0 = "2026-09-14T10:00:00.000Z";

const scoped = (threadId: string = CALLER): BridgeAuthorization => ({
  context: { threadId, cwd: "/p/own" },
});

const projectShell = (
  id: ProjectId,
  overrides: Partial<OrchestrationProjectShell> = {},
): OrchestrationProjectShell =>
  ({
    id,
    title: id,
    workspaceRoot: id === OWN_PROJECT ? "/p/own" : "/p/other",
    defaultModelSelection: { instanceId: "codex", model: "gpt-5.4" },
    scripts: [],
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }) as OrchestrationProjectShell;

const threadShell = (
  id: ThreadId,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell =>
  ({
    id,
    projectId: OWN_PROJECT,
    title: id,
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-4-6" },
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  }) as OrchestrationThreadShell;

const message = (overrides: Partial<OrchestrationMessage>): OrchestrationMessage =>
  ({
    id: `m-${Math.random()}`,
    role: "user",
    text: "",
    turnId: null,
    streaming: false,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  }) as OrchestrationMessage;

const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: T0,
    models: [{ slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  },
];

interface Fixture {
  readonly handlers: ReturnType<typeof makeAgentThreadsHandlers>;
  readonly dispatched: Array<{
    readonly command: OrchestrationCommand;
    readonly origin: OrchestrationCommandOrigin | undefined;
  }>;
  readonly threads: Map<string, OrchestrationThreadShell>;
}

function makeFixture(options?: {
  readonly scope?: AgentThreadsScope;
  readonly threads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly projects?: ReadonlyArray<OrchestrationProjectShell>;
  readonly messages?: ReadonlyArray<OrchestrationMessage>;
  readonly dispatchError?: OrchestrationDispatchError;
  readonly onSleep?: (threads: Map<string, OrchestrationThreadShell>) => void;
}): Fixture {
  const dispatched: Fixture["dispatched"] = [];
  const threads = new Map<string, OrchestrationThreadShell>(
    (
      options?.threads ?? [
        threadShell(CALLER),
        threadShell(CHILD, { spawnedByThreadId: CALLER, controller: "agent" }),
        threadShell(FOREIGN, {
          spawnedByThreadId: "someone-else" as ThreadId,
          controller: "agent",
        }),
      ]
    ).map((thread) => [thread.id, thread]),
  );
  const projects = new Map<string, OrchestrationProjectShell>(
    (options?.projects ?? [projectShell(OWN_PROJECT), projectShell(OTHER_PROJECT)]).map(
      (project) => [project.id, project],
    ),
  );
  let clock = Date.parse(T0);

  const handlers = makeAgentThreadsHandlers({
    engine: {
      dispatch: (command, dispatchOptions) =>
        options?.dispatchError
          ? Effect.fail(options.dispatchError)
          : Effect.sync(() => {
              dispatched.push({ command, origin: dispatchOptions?.origin });
              return { sequence: dispatched.length };
            }),
    },
    projections: {
      getThreadShellById: (threadId) => Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
      getThreadDetailById: (threadId) =>
        Effect.succeed(
          threads.has(threadId)
            ? Option.some({
                ...threads.get(threadId),
                messages: options?.messages ?? [],
              } as unknown as OrchestrationThread)
            : Option.none(),
        ),
      getProjectShellById: (projectId) =>
        Effect.succeed(Option.fromNullishOr(projects.get(projectId))),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [...projects.values()],
          threads: [...threads.values()],
          updatedAt: T0,
        }),
      getActiveProjectByWorkspaceRoot: (root) =>
        Effect.succeed(
          Option.fromNullishOr(
            [...projects.values()].find((project) => project.workspaceRoot === root) as
              | OrchestrationProject
              | undefined,
          ),
        ),
      getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
    },
    getAgentThreadsScope: Effect.succeed(options?.scope ?? "own-project"),
    getProviders: Effect.succeed(providers),
    pollIntervalMs: 1_000,
    nowMs: () => clock,
    sleep: (ms) =>
      Effect.sync(() => {
        clock += ms;
        options?.onSleep?.(threads);
      }),
  });
  return { handlers, dispatched, threads };
}

const body = (reply: { readonly body: unknown }) => reply.body as Record<string, any>;

describe("agent threads bridge: auth", () => {
  it.effect("401 without a valid token, 403 for the base token or an unknown caller", () =>
    Effect.gen(function* () {
      const { handlers, dispatched } = makeFixture();
      const noToken = yield* handlers.createThread(null, { text: "hi" });
      assert.strictEqual(noToken.status, 401);
      const baseToken = yield* handlers.listThreads({ context: undefined });
      assert.strictEqual(baseToken.status, 403);
      assert.strictEqual(body(baseToken).error, "thread_context_required");
      const cwdOnly = yield* handlers.listThreads({ context: { cwd: "/p/own" } });
      assert.strictEqual(cwdOnly.status, 403);
      const gone = yield* handlers.createThread(scoped("thread-deleted"), { text: "hi" });
      assert.strictEqual(gone.status, 403);
      assert.strictEqual(dispatched.length, 0);
    }),
  );
});

describe("agent threads bridge: POST /api/threads", () => {
  it.effect("spawns in the caller's project with its model and modes, then starts the turn", () =>
    Effect.gen(function* () {
      const { handlers, dispatched } = makeFixture();
      const reply = yield* handlers.createThread(scoped(), { text: "  Write tests\nfor billing " });
      assert.strictEqual(reply.status, 200);
      assert.deepStrictEqual(
        { ...body(reply), threadId: undefined },
        {
          ok: true,
          threadId: undefined,
          projectId: OWN_PROJECT,
          title: "Write tests for billing",
          controller: "agent",
        },
      );
      assert.strictEqual(dispatched.length, 2);
      const [create, turn] = dispatched;
      assert.deepStrictEqual(create?.origin, { kind: "agent", threadId: CALLER });
      assert.deepStrictEqual(turn?.origin, { kind: "agent", threadId: CALLER });
      const createCommand = create?.command as Extract<
        OrchestrationCommand,
        { type: "thread.create" }
      >;
      assert.strictEqual(createCommand.type, "thread.create");
      assert.strictEqual(createCommand.spawnedByThreadId, CALLER);
      assert.strictEqual(createCommand.projectId, OWN_PROJECT);
      assert.deepStrictEqual(createCommand.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      });
      assert.strictEqual(createCommand.runtimeMode, "full-access");
      assert.strictEqual(createCommand.interactionMode, "plan");
      const turnCommand = turn?.command as Extract<
        OrchestrationCommand,
        { type: "thread.turn.start" }
      >;
      assert.strictEqual(turnCommand.type, "thread.turn.start");
      assert.strictEqual(turnCommand.threadId, createCommand.threadId);
      assert.strictEqual(turnCommand.message.text, "Write tests\nfor billing");
      assert.strictEqual(body(reply).threadId, createCommand.threadId);
    }),
  );

  it.effect("rejects empty text and oversized text", () =>
    Effect.gen(function* () {
      const { handlers, dispatched } = makeFixture();
      assert.strictEqual((yield* handlers.createThread(scoped(), { text: " " })).status, 400);
      assert.strictEqual((yield* handlers.createThread(scoped(), null)).status, 400);
      assert.strictEqual(
        (yield* handlers.createThread(scoped(), { text: "x".repeat(32_001) })).status,
        400,
      );
      assert.strictEqual(dispatched.length, 0);
    }),
  );

  it.effect("another project is 403 project_not_allowed under own-project scope", () =>
    Effect.gen(function* () {
      const { handlers, dispatched } = makeFixture();
      const byId = yield* handlers.createThread(scoped(), { text: "hi", projectId: OTHER_PROJECT });
      assert.strictEqual(byId.status, 403);
      assert.strictEqual(body(byId).error, "project_not_allowed");
      const byCwd = yield* handlers.createThread(scoped(), { text: "hi", cwd: "/p/other" });
      assert.strictEqual(byCwd.status, 403);
      // Own project by id or by a cwd inside it stays allowed.
      const own = yield* handlers.createThread(scoped(), { text: "hi", cwd: "/p/own/src" });
      assert.strictEqual(own.status, 200);
      assert.strictEqual(body(own).projectId, OWN_PROJECT);
      assert.strictEqual(dispatched.length, 2);
    }),
  );

  it.effect(
    "any-project scope allows another project with its default model and inherited modes",
    () =>
      Effect.gen(function* () {
        const { handlers, dispatched } = makeFixture({ scope: "any-project" });
        const reply = yield* handlers.createThread(scoped(), { text: "hi", cwd: "/p/other/" });
        assert.strictEqual(reply.status, 200);
        assert.strictEqual(body(reply).projectId, OTHER_PROJECT);
        const create = dispatched[0]?.command as Extract<
          OrchestrationCommand,
          { type: "thread.create" }
        >;
        assert.deepStrictEqual(create.modelSelection, {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        });
        // No threads in the other project to inherit from → narrowest mode.
        assert.strictEqual(create.runtimeMode, "approval-required");
        assert.strictEqual(create.interactionMode, "default");

        const unknown = yield* handlers.createThread(scoped(), { text: "hi", projectId: "nope" });
        assert.strictEqual(unknown.status, 404);
      }),
  );

  it.effect("400 when the other project has no default model and no provider is given", () =>
    Effect.gen(function* () {
      const { handlers } = makeFixture({
        scope: "any-project",
        projects: [
          projectShell(OWN_PROJECT),
          projectShell(OTHER_PROJECT, { defaultModelSelection: null }),
        ],
      });
      const reply = yield* handlers.createThread(scoped(), {
        text: "hi",
        projectId: OTHER_PROJECT,
      });
      assert.strictEqual(reply.status, 400);
      assert.strictEqual(body(reply).error, "model_required");
    }),
  );

  it.effect("resolves an explicit provider, rejects an unknown one", () =>
    Effect.gen(function* () {
      const { handlers, dispatched } = makeFixture();
      const reply = yield* handlers.createThread(scoped(), { text: "hi", provider: "codex" });
      assert.strictEqual(reply.status, 200);
      const create = dispatched[0]?.command as Extract<
        OrchestrationCommand,
        { type: "thread.create" }
      >;
      assert.deepStrictEqual(create.modelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
      const bad = yield* handlers.createThread(scoped(), { text: "hi", provider: "gemini" });
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(body(bad).error, "invalid_provider");
    }),
  );
});

describe("agent threads bridge: reading children", () => {
  it.effect("lists only the caller's children", () =>
    Effect.gen(function* () {
      const { handlers } = makeFixture({
        messages: [message({ role: "assistant", text: "done" })],
      });
      const reply = yield* handlers.listThreads(scoped());
      assert.strictEqual(reply.status, 200);
      const threads = body(reply).threads as Array<Record<string, unknown>>;
      assert.deepStrictEqual(
        threads.map((thread) => [
          thread.id,
          thread.status,
          thread.controller,
          thread.lastAssistantText,
        ]),
        [[CHILD, "idle", "agent", "done"]],
      );
    }),
  );

  it.effect("404 for a thread that is not the caller's child", () =>
    Effect.gen(function* () {
      const { handlers, dispatched } = makeFixture();
      const params = { limit: null, waitMs: null };
      assert.strictEqual(
        (yield* handlers.getThread(scoped(), { threadId: FOREIGN, ...params })).status,
        404,
      );
      assert.strictEqual(
        (yield* handlers.getThread(scoped(), { threadId: CALLER, ...params })).status,
        404,
      );
      assert.strictEqual(
        (yield* handlers.getThread(scoped(), { threadId: "missing", ...params })).status,
        404,
      );
      assert.strictEqual(
        (yield* handlers.sendMessage(scoped(), { threadId: FOREIGN, body: { text: "hi" } })).status,
        404,
      );
      assert.strictEqual(
        (yield* handlers.releaseThread(scoped(), { threadId: FOREIGN })).status,
        404,
      );
      assert.strictEqual(dispatched.length, 0);
    }),
  );

  it.effect("maps message authors and honors limit", () =>
    Effect.gen(function* () {
      const { handlers } = makeFixture({
        messages: [
          message({ role: "user", text: "old", sentByThreadId: CALLER }),
          message({ role: "user", text: "task", sentByThreadId: CALLER }),
          message({ role: "assistant", text: "working" }),
          message({ role: "user", text: "stop, do X instead" }),
        ],
      });
      const reply = yield* handlers.getThread(scoped(), {
        threadId: CHILD,
        limit: "3",
        waitMs: null,
      });
      assert.strictEqual(reply.status, 200);
      assert.deepStrictEqual(
        (body(reply).messages as Array<Record<string, unknown>>).map((m) => [m.author, m.text]),
        [
          ["you", "task"],
          ["assistant", "working"],
          ["human", "stop, do X instead"],
        ],
      );
      assert.strictEqual(body(reply).controller, "agent");
      assert.strictEqual(body(reply).pendingApproval, false);
    }),
  );

  it.effect("long-polls while running and returns once the thread settles", () =>
    Effect.gen(function* () {
      let sleeps = 0;
      const { handlers } = makeFixture({
        threads: [
          threadShell(CALLER),
          threadShell(CHILD, {
            spawnedByThreadId: CALLER,
            controller: "agent",
            session: { status: "running", updatedAt: T0 } as OrchestrationThreadShell["session"],
          }),
        ],
        onSleep: (threads) => {
          sleeps += 1;
          if (sleeps === 3) {
            threads.set(
              CHILD,
              threadShell(CHILD, {
                spawnedByThreadId: CALLER,
                controller: "agent",
                session: { status: "ready", updatedAt: T0 } as OrchestrationThreadShell["session"],
              }),
            );
          }
        },
      });
      const reply = yield* handlers.getThread(scoped(), {
        threadId: CHILD,
        limit: null,
        waitMs: "60000",
      });
      assert.strictEqual(sleeps, 3);
      assert.strictEqual(body(reply).status, "idle");

      // waitMs=0 never sleeps.
      sleeps = 0;
      const { handlers: running } = makeFixture({
        threads: [
          threadShell(CALLER),
          threadShell(CHILD, {
            spawnedByThreadId: CALLER,
            controller: "agent",
            session: { status: "running", updatedAt: T0 } as OrchestrationThreadShell["session"],
          }),
        ],
        onSleep: () => {
          sleeps += 1;
        },
      });
      const immediate = yield* running.getThread(scoped(), {
        threadId: CHILD,
        limit: null,
        waitMs: null,
      });
      assert.strictEqual(sleeps, 0);
      assert.strictEqual(body(immediate).status, "running");
    }),
  );
});

describe("agent threads bridge: driving children", () => {
  it.effect("sends a turn with the agent origin", () =>
    Effect.gen(function* () {
      const { handlers, dispatched } = makeFixture();
      const reply = yield* handlers.sendMessage(scoped(), {
        threadId: CHILD,
        body: { text: "next" },
      });
      assert.deepStrictEqual(reply, { status: 200, body: { ok: true } });
      assert.strictEqual(dispatched.length, 1);
      assert.deepStrictEqual(dispatched[0]?.origin, { kind: "agent", threadId: CALLER });
      const turn = dispatched[0]?.command as Extract<
        OrchestrationCommand,
        { type: "thread.turn.start" }
      >;
      assert.strictEqual(turn.threadId, CHILD);
      assert.strictEqual(turn.message.text, "next");
    }),
  );

  it.effect("409 human_in_control before dispatch when a human took over", () =>
    Effect.gen(function* () {
      const { handlers, dispatched } = makeFixture({
        threads: [
          threadShell(CALLER),
          threadShell(CHILD, { spawnedByThreadId: CALLER, controller: "human" }),
        ],
      });
      const reply = yield* handlers.sendMessage(scoped(), {
        threadId: CHILD,
        body: { text: "next" },
      });
      assert.deepStrictEqual(reply, {
        status: 409,
        body: { ok: false, error: "human_in_control", message: HUMAN_IN_CONTROL_MESSAGE },
      });
      assert.strictEqual(dispatched.length, 0);
      // Reading is still allowed.
      const read = yield* handlers.getThread(scoped(), {
        threadId: CHILD,
        limit: null,
        waitMs: null,
      });
      assert.strictEqual(read.status, 200);
      assert.strictEqual(body(read).controller, "human");
    }),
  );

  it.effect("maps decider rejection reasons to bridge status codes", () =>
    Effect.gen(function* () {
      const race = makeFixture({
        dispatchError: new OrchestrationCommandInvariantError({
          commandType: "thread.turn.start",
          detail: "human_in_control: A human has taken control of thread 'thread-child'.",
        }),
      });
      const raced = yield* race.handlers.sendMessage(scoped(), {
        threadId: CHILD,
        body: { text: "x" },
      });
      assert.strictEqual(raced.status, 409);
      assert.strictEqual(body(raced).error, "human_in_control");

      const notYours = makeFixture({
        dispatchError: new OrchestrationCommandInvariantError({
          commandType: "thread.control.set",
          detail:
            "not_your_thread: Thread 'thread-child' was not spawned by thread 'thread-caller'.",
        }),
      });
      const rejected = yield* notYours.handlers.releaseThread(scoped(), { threadId: CHILD });
      assert.strictEqual(rejected.status, 404);

      const takeControl = makeFixture({
        dispatchError: new OrchestrationCommandInvariantError({
          commandType: "thread.control.set",
          detail: "agent_cannot_take_control: An agent may only release thread 'thread-child'.",
        }),
      });
      const forbidden = yield* takeControl.handlers.releaseThread(scoped(), { threadId: CHILD });
      assert.strictEqual(forbidden.status, 403);

      const mismatch = makeFixture({
        dispatchError: new OrchestrationCommandInvariantError({
          commandType: "thread.create",
          detail: "spawn_origin_mismatch: Thread 'x' claims parent 'y'.",
        }),
      });
      const bug = yield* mismatch.handlers.createThread(scoped(), { text: "hi" });
      assert.strictEqual(bug.status, 500);
      assert.strictEqual(body(bug).error, "internal_error");
    }),
  );

  it.effect("release dispatches thread.control.set to the human", () =>
    Effect.gen(function* () {
      const { handlers, dispatched } = makeFixture();
      const reply = yield* handlers.releaseThread(scoped(), { threadId: CHILD });
      assert.deepStrictEqual(reply, { status: 200, body: { ok: true, controller: "human" } });
      assert.strictEqual(dispatched.length, 1);
      const command = dispatched[0]?.command as Extract<
        OrchestrationCommand,
        { type: "thread.control.set" }
      >;
      assert.strictEqual(command.type, "thread.control.set");
      assert.strictEqual(command.threadId, CHILD);
      assert.strictEqual(command.controller, "human");
      assert.deepStrictEqual(dispatched[0]?.origin, { kind: "agent", threadId: CALLER });
    }),
  );
});
