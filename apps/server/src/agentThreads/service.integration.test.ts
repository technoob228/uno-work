/**
 * The bridge against the real engine: decider rules, projections of
 * `controller` / `spawnedByThreadId` / `sentByThreadId`, in-memory SQLite.
 */
import { CommandId, MessageId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { BridgeAuthorization } from "../browserBridge.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver.ts";
import { makeAgentThreadsHandlers } from "./service.ts";

const PROJECT = ProjectId.make("project-integration");
const CALLER = ThreadId.make("thread-caller");
const auth: BridgeAuthorization = { kind: "thread", context: { threadId: CALLER } };

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

async function createSystem() {
  const layer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-threads-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  dispose = () => runtime.dispose();
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const projections = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  const createdAt = new Date().toISOString();

  await run(
    engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project"),
      projectId: PROJECT,
      title: "Integration",
      workspaceRoot: "/tmp/agent-threads-integration",
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      createdAt,
    }),
  );
  await run(
    engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-caller"),
      threadId: CALLER,
      projectId: PROJECT,
      title: "Caller",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    }),
  );

  const handlers = makeAgentThreadsHandlers({
    engine,
    projections,
    getAgentThreadsScope: Effect.succeed("own-project"),
    getProviders: Effect.succeed([]),
  });
  const humanSends = (threadId: ThreadId, text: string) =>
    run(
      engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`cmd-human-${crypto.randomUUID()}`),
        threadId,
        message: {
          messageId: MessageId.make(crypto.randomUUID()),
          role: "user",
          text,
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      }),
    );
  const humanSetsController = (threadId: ThreadId, controller: "human" | "agent") =>
    run(
      engine.dispatch({
        type: "thread.control.set",
        commandId: CommandId.make(`cmd-control-${crypto.randomUUID()}`),
        threadId,
        controller,
        createdAt: new Date().toISOString(),
      }),
    );
  return { run, handlers, projections, humanSends, humanSetsController };
}

const body = (reply: { readonly body: unknown }) => reply.body as Record<string, any>;

describe("agent threads bridge (real engine)", () => {
  it("spawn → send → human takes over → 409 → hand back → release", async () => {
    const system = await createSystem();
    const { run, handlers } = system;

    const created = await run(handlers.createThread(auth, { text: "Do the subtask" }));
    expect(created.status).toBe(200);
    const childId = ThreadId.make(body(created).threadId);

    const shell = await run(system.projections.getThreadShellById(childId));
    expect(Option.isSome(shell) && shell.value.spawnedByThreadId).toBe(CALLER);
    expect(Option.isSome(shell) && shell.value.controller).toBe("agent");

    const listed = await run(handlers.listThreads(auth));
    expect((body(listed).threads as Array<{ id: string }>).map((thread) => thread.id)).toEqual([
      childId,
    ]);

    const read = await run(
      handlers.getThread(auth, { threadId: childId, limit: null, waitMs: null }),
    );
    expect(body(read).controller).toBe("agent");
    // No harness in this test: the sent message is pending a session.
    expect(body(read).status).toBe("running");
    expect(body(read).messages).toMatchObject([
      { role: "user", author: "you", text: "Do the subtask" },
    ]);

    const sent = await run(
      handlers.sendMessage(auth, { threadId: childId, body: { text: "More" } }),
    );
    expect(sent.status).toBe(200);

    await system.humanSends(childId, "I'll take it from here");
    const blocked = await run(
      handlers.sendMessage(auth, { threadId: childId, body: { text: "Still me" } }),
    );
    expect(blocked.status).toBe(409);
    expect(body(blocked).error).toBe("human_in_control");

    const afterHuman = await run(
      handlers.getThread(auth, { threadId: childId, limit: "10", waitMs: null }),
    );
    expect(body(afterHuman).controller).toBe("human");
    expect(body(afterHuman).controlChangedAt).not.toBeNull();
    expect(
      (body(afterHuman).messages as Array<{ author: string }>).map((message) => message.author),
    ).toEqual(["you", "you", "human"]);

    // Releasing an already-human thread is a no-op success.
    const noop = await run(handlers.releaseThread(auth, { threadId: childId }));
    expect(noop).toEqual({ status: 200, body: { ok: true, controller: "human" } });

    await system.humanSetsController(childId, "agent");
    const again = await run(
      handlers.sendMessage(auth, { threadId: childId, body: { text: "Back to work" } }),
    );
    expect(again.status).toBe(200);

    const released = await run(handlers.releaseThread(auth, { threadId: childId }));
    expect(released.status).toBe(200);
    const finalShell = await run(system.projections.getThreadShellById(childId));
    expect(Option.isSome(finalShell) && finalShell.value.controller).toBe("human");
  });

  it("agents message peers and parents; busy peers and self are refused", async () => {
    const system = await createSystem();
    const { run, handlers } = system;

    const created = await run(handlers.createThread(auth, { text: "Do the subtask" }));
    const childId = ThreadId.make(body(created).threadId);
    const childAuth: BridgeAuthorization = { kind: "thread", context: { threadId: childId } };

    // The child answers its parent — a human-created thread — through the bridge.
    const toParent = await run(
      handlers.sendMessage(childAuth, { threadId: CALLER, body: { text: "Done: 3 files" } }),
    );
    expect(toParent).toEqual({
      status: 200,
      body: { ok: true, threadId: CALLER, relation: "parent" },
    });
    const parent = await run(system.projections.getThreadShellById(CALLER));
    expect(Option.isSome(parent) && parent.value.controller).toBe("human");

    // The parent has not reacted yet (no harness here): a second message is busy.
    const busy = await run(
      handlers.sendMessage(childAuth, { threadId: CALLER, body: { text: "and one more" } }),
    );
    expect(busy.status).toBe(409);
    expect(body(busy).error).toBe("target_busy");

    const listed = await run(handlers.listThreads(childAuth, { scope: "project" }));
    expect(
      Object.fromEntries(
        (body(listed).threads as Array<{ id: string; relation: string }>).map((thread) => [
          thread.id,
          thread.relation,
        ]),
      ),
    ).toEqual({ [CALLER]: "parent", [childId]: "self" });

    const parentView = await run(
      handlers.getThread(childAuth, { threadId: CALLER, limit: null, waitMs: null }),
    );
    expect(body(parentView).messages).toMatchObject([
      { role: "user", author: "you", text: "Done: 3 files" },
    ]);
    const fromChild = await run(
      handlers.getThread(auth, { threadId: CALLER, limit: null, waitMs: null }),
    );
    expect(body(fromChild).messages).toMatchObject([{ author: "agent", fromThreadId: childId }]);

    const self = await run(handlers.sendMessage(auth, { threadId: CALLER, body: { text: "me" } }));
    expect(self.status).toBe(400);
    // Release stays parent-only.
    const released = await run(handlers.releaseThread(childAuth, { threadId: CALLER }));
    expect(released.status).toBe(404);
  });
});
