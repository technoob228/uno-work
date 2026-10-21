/**
 * Assistant presets in the manager tools (decision 21.10): an assistant's own
 * token (`assistant:<projectId>`) is held to its preset on every call —
 * Observer reads only, Helper stays in its projects and never widens a
 * chat's runtime, Full is unchanged.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  assistantTokenLabel,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type AssistantPreset,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type RuntimeMode,
} from "@t3tools/contracts";
import { presetTokenAccess } from "@t3tools/shared/assistantPreset";
import { describe } from "vitest";
import { Effect, Layer, Option, Ref, Stream } from "effect";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ManagerActionProposalRepositoryLive } from "../persistence/Layers/ManagerActionProposals.ts";
import { ManagerCapabilityTokenRepositoryLive } from "../persistence/Layers/ManagerCapabilityTokens.ts";
import { ManagerConnectorRepositoryLive } from "../persistence/Layers/ManagerConnectors.ts";
import { RemindersRepositoryLive } from "../persistence/Layers/Reminders.ts";
import { ManagerCapabilityTokenRepository } from "../persistence/Services/ManagerCapabilityTokens.ts";
import { ProjectionPendingApprovalRepository } from "../persistence/Services/ProjectionPendingApprovals.ts";
import { ManagerApprovalServiceLive } from "./Layers/ManagerApprovalService.ts";
import { ManagerAccountDefaultAi } from "./Layers/AccountDefaultAi.ts";
import { ManagerBudgetServiceLive } from "./Layers/ManagerBudgetService.ts";
import { ManagerTokenAuthServiceLive } from "./Layers/ManagerTokenAuth.ts";
import { ManagerToolServiceLive } from "./Layers/ManagerToolService.ts";
import {
  callerPreset,
  createRuntimeFor,
  executesAtOnce,
  steerDenial,
} from "./assistantPresetGate.ts";
import { ManagerTokenAuthService } from "./Services/ManagerTokenAuth.ts";
import { ManagerToolService } from "./Services/ManagerToolService.ts";

const ASSISTANT = "assistant-scout";
const mine = ProjectId.make("project-mine");
const foreign = ProjectId.make("project-foreign");
const askingThread = ThreadId.make("thread-asking");
const freeThread = ThreadId.make("thread-free");
const foreignThread = ThreadId.make("thread-foreign");
const now = new Date().toISOString();
const modelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-sonnet-4-6",
};

const project = (id: ProjectId): OrchestrationProjectShell => ({
  id,
  title: id,
  workspaceRoot: `/tmp/${id}`,
  defaultModelSelection: modelSelection,
  scripts: [],
  createdAt: now,
  updatedAt: now,
});

const thread = (
  id: ThreadId,
  projectId: ProjectId,
  runtimeMode: RuntimeMode,
): OrchestrationThreadShell => ({
  id,
  projectId,
  title: id,
  modelSelection,
  runtimeMode,
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  pinnedAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const threads = [
  thread(askingThread, mine, "approval-required"),
  thread(freeThread, mine, "full-access"),
  thread(foreignThread, foreign, "approval-required"),
];
const projects = [project(mine), project(foreign)];

const detail = (shell: OrchestrationThreadShell): OrchestrationThread => ({
  ...shell,
  deletedAt: null,
  messages: [
    {
      id: MessageId.make("m1"),
      role: "assistant",
      text: "done",
      turnId: TurnId.make("t1"),
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
});

const makeLayer = (dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>) =>
  Layer.mergeAll(ManagerToolServiceLive, ManagerTokenAuthServiceLive).pipe(
    Layer.provideMerge(ManagerApprovalServiceLive),
    Layer.provide(
      Layer.succeed(ManagerAccountDefaultAi, {
        get: () => Effect.succeed(null),
        set: () => Effect.void,
        refreshFromAccount: () => Effect.void,
        spawnModelSelection: () => Effect.succeed(null),
      }),
    ),
    Layer.provide(ManagerBudgetServiceLive),
    Layer.provideMerge(
      Layer.mergeAll(
        ManagerActionProposalRepositoryLive,
        ManagerCapabilityTokenRepositoryLive,
        ManagerConnectorRepositoryLive,
        RemindersRepositoryLive,
      ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ),
    Layer.provide(
      Layer.mock(ProjectionPendingApprovalRepository)({ listByThreadId: () => Effect.succeed([]) }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        readEvents: () => Stream.empty,
        dispatch: (command) =>
          Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({ sequence: 1 })),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({ snapshotSequence: 1, projects, threads, updatedAt: now }),
        getProjectShellById: (id) =>
          Effect.succeed(Option.fromNullishOr(projects.find((entry) => entry.id === id))),
        getThreadShellById: (id) =>
          Effect.succeed(Option.fromNullishOr(threads.find((entry) => entry.id === id))),
        getThreadDetailById: (id) =>
          Effect.succeed(
            Option.map(Option.fromNullishOr(threads.find((entry) => entry.id === id)), detail),
          ),
      }),
    ),
  );

/** The assistant's own token, issued for `preset` on its picked projects. */
const assistantCaller = (preset: AssistantPreset, projectsPicked: "all" | ProjectId[] = [mine]) =>
  Effect.gen(function* () {
    const auth = yield* ManagerTokenAuthService;
    const issued = yield* auth.issueToken({
      label: assistantTokenLabel(ASSISTANT),
      ...presetTokenAccess(preset, projectsPicked, ASSISTANT),
    });
    return yield* auth.authenticate(`Bearer ${issued.token}`);
  });

const run = <A, E>(
  body: (dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>) => Effect.Effect<A, E, any>,
) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    return yield* body(dispatched).pipe(Effect.provide(makeLayer(dispatched)));
  });

it.layer(NodeServices.layer)("manager tools under assistant presets", (it) => {
  it.effect("Observer reads its projects but can't start, write, stop or approve", () =>
    run(() =>
      Effect.gen(function* () {
        const tools = yield* ManagerToolService;
        const caller = yield* assistantCaller("observer");

        const listed = yield* tools.listThreads(caller, {});
        expect(listed.threads.map((entry) => entry.threadId).toSorted()).toEqual(
          [askingThread, freeThread].toSorted(),
        );
        yield* tools.readThreadDetail(caller, { threadId: askingThread });

        const create = yield* Effect.flip(
          tools.createThread(caller, { projectId: mine, title: "x", prompt: "do it" }),
        );
        expect(create._tag).toBe("ManagerPresetDeniedError");
        expect(create.message).toContain("Observer");
        const send = yield* Effect.flip(
          tools.sendTurn(caller, { threadId: askingThread, prompt: "go on" }),
        );
        expect(send._tag).toBe("ManagerPresetDeniedError");
        const stop = yield* Effect.flip(tools.interruptTurn(caller, { threadId: askingThread }));
        expect(stop._tag).toBe("ManagerPresetDeniedError");
        const approve = yield* Effect.flip(
          tools.respondToRequest(caller, {
            threadId: askingThread,
            requestId: "r1" as never,
            decision: "accept" as never,
          }),
        );
        expect(approve._tag).toBe("ManagerPresetDeniedError");
      }),
    ),
  );

  it.effect("Observer can still remind the person", () =>
    run(() =>
      Effect.gen(function* () {
        const tools = yield* ManagerToolService;
        const caller = yield* assistantCaller("observer");
        const reminder = yield* Effect.flip(
          tools.createReminder(caller, { message: "standup", dueInSeconds: 60 }),
        );
        // Not refused by the preset: it only lacks a messenger in this test.
        expect(reminder._tag).toBe("ManagerInvalidRequestError");
      }),
    ),
  );

  it.effect("Helper starts chats at once in its projects, capped at approval-required", () =>
    run((dispatched) =>
      Effect.gen(function* () {
        const tools = yield* ManagerToolService;
        const caller = yield* assistantCaller("helper");

        const receipt = yield* tools.createThread(caller, {
          projectId: mine,
          title: "Fix",
          prompt: "fix it",
          runtimeMode: "full-access",
        });
        expect(receipt.status).toBe("executed");
        const create = (yield* Ref.get(dispatched)).find(
          (command) => command.type === "thread.create",
        );
        expect(create?.type === "thread.create" && create.runtimeMode).toBe("approval-required");

        const outside = yield* Effect.flip(
          tools.createThread(caller, { projectId: foreign, title: "x", prompt: "x" }),
        );
        expect(outside._tag).toBe("ManagerProjectNotAllowedError");
        const outsideRead = yield* Effect.flip(
          tools.getThreadStatus(caller, { threadId: foreignThread }),
        );
        expect(outsideRead._tag).toBe("ManagerProjectNotAllowedError");
      }),
    ),
  );

  it.effect("Helper writes in asking chats, not in freer ones, and approves nothing", () =>
    run(() =>
      Effect.gen(function* () {
        const tools = yield* ManagerToolService;
        const caller = yield* assistantCaller("helper");

        const sent = yield* tools.sendTurn(caller, { threadId: askingThread, prompt: "more" });
        expect(sent.status).toBe("executed");
        const wider = yield* Effect.flip(
          tools.sendTurn(caller, { threadId: freeThread, prompt: "more" }),
        );
        expect(wider._tag).toBe("ManagerPresetDeniedError");
        expect(wider.message).toContain("full-access");
        // Stopping a freer chat is fine: it only takes power away.
        const stopped = yield* tools.interruptTurn(caller, { threadId: freeThread });
        expect(stopped.status).toBe("executed");
        const approve = yield* Effect.flip(
          tools.respondToRequest(caller, {
            threadId: askingThread,
            requestId: "r1" as never,
            decision: "accept" as never,
          }),
        );
        expect(approve._tag).toBe("ManagerPresetDeniedError");
      }),
    ),
  );

  it.effect("Full is unchanged: every project, its runtime, writes in any chat", () =>
    run((dispatched) =>
      Effect.gen(function* () {
        const tools = yield* ManagerToolService;
        const caller = yield* assistantCaller("full", "all");

        const receipt = yield* tools.createThread(caller, {
          projectId: foreign,
          title: "Ship",
          prompt: "ship it",
          runtimeMode: "full-access",
        });
        expect(receipt.status).toBe("executed");
        const create = (yield* Ref.get(dispatched)).find(
          (command) => command.type === "thread.create",
        );
        expect(create?.type === "thread.create" && create.runtimeMode).toBe("full-access");
        const sent = yield* tools.sendTurn(caller, { threadId: freeThread, prompt: "more" });
        expect(sent.status).toBe("executed");
      }),
    ),
  );

  it.effect("a preset change holds from the next call, without a new token", () =>
    run(() =>
      Effect.gen(function* () {
        const tools = yield* ManagerToolService;
        const auth = yield* ManagerTokenAuthService;
        const issued = yield* auth.issueToken({
          label: assistantTokenLabel(ASSISTANT),
          ...presetTokenAccess("full", "all", ASSISTANT),
        });
        const repository = yield* ManagerCapabilityTokenRepository;
        yield* repository.updateAccess({
          tokenId: issued.descriptor.tokenId,
          ...presetTokenAccess("observer", [mine], ASSISTANT),
        });
        const caller = yield* auth.authenticate(`Bearer ${issued.token}`);
        const denied = yield* Effect.flip(
          tools.createThread(caller, { projectId: mine, title: "x", prompt: "x" }),
        );
        expect(denied._tag).toBe("ManagerPresetDeniedError");
      }),
    ),
  );
});

describe("assistantPresetGate", () => {
  const assistantToken = (preset: AssistantPreset) => ({
    label: assistantTokenLabel(ASSISTANT),
    ...presetTokenAccess(preset, "all", ASSISTANT),
  });
  const settingsToken = {
    label: "my-script",
    scopes: ["threads:read", "threads:write"] as const,
    autoApprove: true,
  };

  it("reads the preset only off an assistant's own token", () => {
    expect(callerPreset(assistantToken("helper"))).toBe("helper");
    expect(callerPreset(settingsToken)).toBeNull();
  });

  it("an assistant's own writes run at once with autoApprove; other tokens also need approve", () => {
    expect(executesAtOnce(assistantToken("full"))).toBe(true);
    expect(executesAtOnce(assistantToken("helper"))).toBe(true);
    expect(executesAtOnce(assistantToken("observer"))).toBe(false);
    expect(executesAtOnce(settingsToken)).toBe(false);
  });

  it("caps the runtime of chats a Helper starts and refuses steering freer ones", () => {
    expect(createRuntimeFor(assistantToken("helper"), "full-access")).toBe("approval-required");
    expect(createRuntimeFor(assistantToken("full"), "full-access")).toBe("full-access");
    expect(createRuntimeFor(settingsToken, "full-access")).toBe("full-access");
    expect(steerDenial(assistantToken("helper"), "auto-accept-edits")).not.toBeNull();
    expect(steerDenial(assistantToken("helper"), "approval-required")).toBeNull();
    expect(steerDenial(assistantToken("full"), "full-access")).toBeNull();
  });
});
