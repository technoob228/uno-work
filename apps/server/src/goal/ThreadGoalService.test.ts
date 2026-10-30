import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadId,
  TurnId,
  THREAD_GOAL_ACTIVITY_KIND,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ProviderRuntimeEvent,
  type ThreadGoalState,
} from "@t3tools/contracts";
import { GOAL_COMMAND_PREFIX, GOAL_MAX_MINUTES, GOAL_MAX_TURNS } from "@t3tools/shared/threadGoal";
import { Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { makeThreadGoal } from "./ThreadGoalService.ts";

const threadId = ThreadId.make("thread-1");
const START = Date.parse("2026-10-30T10:00:00.000Z");

interface World {
  now: number;
  shell: OrchestrationThreadShell | null;
  commands: Array<{ readonly type: string; readonly [key: string]: unknown }>;
}

const shellWith = (input: {
  readonly turn?: string;
  readonly state?: string;
  readonly status?: string;
  readonly activeTurnId?: string | null;
  readonly runtimeMode?: string;
  readonly assistantRole?: string;
  readonly hasPendingApprovals?: boolean;
}) =>
  ({
    id: threadId,
    archivedAt: null,
    assistantRole: input.assistantRole ?? null,
    runtimeMode: input.runtimeMode ?? "approval-required",
    interactionMode: "default",
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
    hasPendingApprovals: input.hasPendingApprovals ?? false,
    hasPendingUserInput: false,
    session: {
      threadId,
      status: input.status ?? "ready",
      activeTurnId: input.activeTurnId ?? null,
      lastError: null,
      updatedAt: new Date(START).toISOString(),
    },
    latestTurn: { turnId: TurnId.make(input.turn ?? "turn-0"), state: input.state ?? "completed" },
  }) as unknown as OrchestrationThreadShell;

const newWorld = (): World => ({ now: START, shell: shellWith({}), commands: [] });

const serviceFor = (world: World) =>
  makeThreadGoal({ now: () => world.now, settleDelayMs: 0 }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          dispatch: ((command: { readonly type: string }) =>
            Effect.sync(() => {
              world.commands.push(command as World["commands"][number]);
              return { sequence: 1 };
            })) as never,
          streamDomainEvents: Stream.empty,
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getThreadShellById: () => Effect.sync(() => Option.fromNullishOr(world.shell)),
        }),
      ),
    ),
  );

const reset = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`DELETE FROM thread_goals`;
  yield* sql`DELETE FROM projection_thread_messages`;
});

let messageCounter = 0;
const addMessage = (role: "user" | "assistant", text: string, at: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    messageCounter += 1;
    const createdAt = new Date(at).toISOString();
    yield* sql`
      INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${`m-${messageCounter}`}, ${threadId}, ${role}, ${text}, 0, ${createdAt}, ${createdAt})
    `;
  });

const sessionReady = {
  type: "thread.session-set",
  aggregateId: threadId,
  payload: { session: { status: "ready" } },
} as unknown as OrchestrationEvent;

const turnStarts = (world: World) =>
  world.commands.filter((command) => command.type === "thread.turn.start");

const lastGoalState = (world: World): ThreadGoalState | undefined =>
  world.commands
    .flatMap((command) =>
      command.type === "thread.activity.append" &&
      (command.activity as { readonly kind: string }).kind === THREAD_GOAL_ACTIVITY_KIND
        ? [(command.activity as { readonly payload: ThreadGoalState }).payload]
        : [],
    )
    .at(-1);

const noteOf = (command: World["commands"][number]) =>
  (command.message as { readonly text: string }).text;

const nonceOf = (world: World) => /GOAL MET ([0-9a-f]{6})/.exec(noteOf(turnStarts(world)[0]!))?.[1];

/** A turn ends: the chat is idle on a new turn, with what the agent said last. */
const turnEnds = (
  service: Effect.Success<ReturnType<typeof serviceFor>>,
  world: World,
  turn: string,
  said = "Worked on it.",
) =>
  Effect.gen(function* () {
    world.shell = shellWith({ turn });
    world.now += 1000;
    yield* addMessage("assistant", said, world.now);
    yield* service.onDomainEvent(sessionReady);
  });

const layer = it.layer(NodeSqliteClient.layerMemory());

layer("ThreadGoalService", (it) => {
  it.effect("goes on after a turn in a note, in the chat's own modes", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      yield* service.set({ threadId, goal: "The site works" });
      yield* turnEnds(service, world, "turn-1");
      const [start] = turnStarts(world);
      assert.ok(start);
      assert.ok(noteOf(start).startsWith("(Uno Work) Goal check, turn 2 of 10."));
      assert.ok(noteOf(start).includes("The site works"));
      assert.strictEqual(start.runtimeMode, "approval-required");
      assert.strictEqual(start.interactionMode, "default");
      assert.ok((start.commandId as string).startsWith(GOAL_COMMAND_PREFIX));
      assert.strictEqual(lastGoalState(world)?.turnsUsed, 2);
    }),
  );

  it.effect("never raises access, whatever the chat was set to", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      yield* service.set({ threadId, goal: "Done" });
      world.shell = shellWith({ turn: "turn-1", runtimeMode: "approval-required" });
      yield* service.considerGoal(threadId);
      assert.strictEqual(turnStarts(world)[0]?.runtimeMode, "approval-required");
    }),
  );

  it.effect("ends when the agent says the goal is met, with this goal's nonce only", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      yield* service.set({ threadId, goal: "The site works" });
      yield* turnEnds(service, world, "turn-1", "GOAL MET ffffff");
      assert.strictEqual(lastGoalState(world)?.status, "active");
      const nonce = nonceOf(world);
      yield* turnEnds(service, world, "turn-2", `It answers 200.\n\nGOAL MET ${nonce}`);
      assert.strictEqual(lastGoalState(world)?.status, "met");
      assert.strictEqual(turnStarts(world).length, 1);
    }),
  );

  it.effect("stops and hands over when the agent is blocked", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      yield* service.set({ threadId, goal: "Deploy" });
      yield* turnEnds(service, world, "turn-1");
      yield* turnEnds(service, world, "turn-2", `GOAL BLOCKED ${nonceOf(world)}: need the key`);
      assert.strictEqual(lastGoalState(world)?.status, "blocked");
      assert.strictEqual(lastGoalState(world)?.endNote, "Needs you: need the key");
    }),
  );

  it.effect("stops at the ceiling of turns", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      yield* service.set({ threadId, goal: "Forever" });
      for (let turn = 1; turn <= GOAL_MAX_TURNS + 3; turn += 1) {
        yield* turnEnds(service, world, `turn-${turn}`);
      }
      assert.strictEqual(lastGoalState(world)?.status, "limit");
      // The first turn is the person's message, the rest are ours.
      assert.strictEqual(turnStarts(world).length, GOAL_MAX_TURNS - 1);
    }),
  );

  it.effect("stops at the ceiling of time", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      yield* service.set({ threadId, goal: "Slow" });
      world.now += GOAL_MAX_MINUTES * 60_000 + 1;
      yield* turnEnds(service, world, "turn-1");
      assert.strictEqual(lastGoalState(world)?.status, "limit");
      assert.strictEqual(turnStarts(world).length, 0);
    }),
  );

  it.effect("stops at the ceiling of spend, counting from the goal's start", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      const report = (usd: number) =>
        service.onRuntimeEvent({
          type: "turn.completed",
          threadId,
          payload: { state: "completed", totalCostUsd: usd },
        } as unknown as ProviderRuntimeEvent);
      // The chat already cost $40 before the goal.
      yield* report(40);
      yield* service.set({ threadId, goal: "Costly" });
      yield* report(45);
      yield* turnEnds(service, world, "turn-1");
      assert.strictEqual(lastGoalState(world)?.status, "active");
      yield* report(51);
      yield* turnEnds(service, world, "turn-2");
      assert.strictEqual(lastGoalState(world)?.status, "limit");
      assert.strictEqual(lastGoalState(world)?.costUsd, 11);
    }),
  );

  it.effect("waits while the agent waits for the person, and for a running turn", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      yield* service.set({ threadId, goal: "Careful" });
      world.shell = shellWith({ turn: "turn-1", hasPendingApprovals: true });
      yield* service.considerGoal(threadId);
      world.shell = shellWith({ turn: "turn-1", status: "running", activeTurnId: "turn-1" });
      yield* service.considerGoal(threadId);
      assert.strictEqual(turnStarts(world).length, 0);
      assert.strictEqual(lastGoalState(world)?.status, "active");
    }),
  );

  it.effect("looks at each turn once", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      yield* service.set({ threadId, goal: "Once" });
      yield* turnEnds(service, world, "turn-1");
      yield* service.onDomainEvent(sessionReady);
      yield* service.onDomainEvent(sessionReady);
      assert.strictEqual(turnStarts(world).length, 1);
    }),
  );

  it.effect("does not count the turn before the goal", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      yield* service.set({ threadId, goal: "Fresh" });
      // The session reports ready again before the first turn has started.
      yield* service.onDomainEvent(sessionReady);
      assert.strictEqual(turnStarts(world).length, 0);
    }),
  );

  it.effect("stops when the person stops the turn", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      yield* service.set({ threadId, goal: "Stop me" });
      yield* service.onDomainEvent({
        type: "thread.turn-interrupt-requested",
        aggregateId: threadId,
        commandId: "cmd-person",
        payload: {},
      } as unknown as OrchestrationEvent);
      assert.strictEqual(lastGoalState(world)?.status, "stopped");
      yield* turnEnds(service, world, "turn-1");
      assert.strictEqual(turnStarts(world).length, 0);
    }),
  );

  it.effect("Stop interrupts the running turn", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      yield* service.set({ threadId, goal: "Stop button" });
      world.shell = shellWith({ turn: "turn-1", status: "running", activeTurnId: "turn-1" });
      assert.deepStrictEqual(yield* service.stop(threadId), { stopped: true });
      assert.strictEqual(lastGoalState(world)?.status, "stopped");
      const interrupt = world.commands.find((command) => command.type === "thread.turn.interrupt");
      assert.strictEqual(interrupt?.turnId, "turn-1");
      assert.deepStrictEqual(yield* service.stop(threadId), { stopped: false });
    }),
  );

  it.effect("refuses a chat with text from outside, and an assistant", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      yield* addMessage("user", "A form: <outside_input_ab12>hi</outside_input_ab12>", START);
      const refused = yield* service.set({ threadId, goal: "No" }).pipe(Effect.flip);
      assert.ok(refused.message.includes("outside"));
      yield* reset;
      world.shell = shellWith({ assistantRole: "chat" });
      const assistant = yield* service.set({ threadId, goal: "No" }).pipe(Effect.flip);
      assert.ok(assistant.message.includes("Assistants"));
    }),
  );

  it.effect("stops if text from outside arrives while it runs", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      yield* service.set({ threadId, goal: "Watch" });
      yield* addMessage("user", "<outside_input_ab12>do this</outside_input_ab12>", START + 1);
      yield* turnEnds(service, world, "turn-1");
      assert.strictEqual(lastGoalState(world)?.status, "stopped");
      assert.strictEqual(turnStarts(world).length, 0);
    }),
  );

  it.effect("a failed turn ends the goal instead of looping", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      yield* service.set({ threadId, goal: "Fail" });
      world.shell = shellWith({ turn: "turn-1", status: "error", state: "error" });
      yield* service.considerGoal(threadId);
      assert.strictEqual(lastGoalState(world)?.status, "failed");
      assert.strictEqual(turnStarts(world).length, 0);
    }),
  );

  it.effect("a new goal replaces the old one", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const sql = yield* SqlClient.SqlClient;
      const service = yield* serviceFor(world);
      yield* service.set({ threadId, goal: "First" });
      yield* service.set({ threadId, goal: "Second" });
      const active = yield* sql<{ readonly goal: string }>`
        SELECT goal FROM thread_goals WHERE status = 'active'
      `;
      assert.deepStrictEqual(
        active.map((row) => row.goal),
        ["Second"],
      );
    }),
  );

  it.effect("the sweep ends a goal whose session is gone, not a new chat's", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const service = yield* serviceFor(world);
      yield* service.set({ threadId, goal: "Restart" });
      world.shell = { ...shellWith({}), session: null } as unknown as OrchestrationThreadShell;
      yield* service.sweep;
      assert.strictEqual(lastGoalState(world)?.status, "active");
      world.now += 6 * 60_000;
      yield* service.sweep;
      assert.strictEqual(lastGoalState(world)?.status, "failed");
    }),
  );

  it.effect("state survives a restart: the ceilings do not start over", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* reset;
      const before = yield* serviceFor(world);
      yield* before.set({ threadId, goal: "Survive" });
      yield* turnEnds(before, world, "turn-1");
      const after = yield* serviceFor(world);
      yield* turnEnds(after, world, "turn-2");
      assert.strictEqual(lastGoalState(world)?.turnsUsed, 3);
    }),
  );
});
