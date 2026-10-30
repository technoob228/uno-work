import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type PlanLimits,
} from "@t3tools/contracts";
import {
  PLAN_RESUME_ENDED_ACTIVITY,
  PLAN_RESUME_GRACE_MS,
  PLAN_RESUME_MESSAGE_PREFIX,
  PLAN_RESUME_SCHEDULED_ACTIVITY,
} from "@t3tools/shared/planLimitRules";
import { Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { PlanLimitsService } from "../planLimits/PlanLimitsService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makePlanResume } from "./PlanResumeService.ts";

const threadId = ThreadId.make("thread-1");
const turn = TurnId.make("turn-1");
const START = Date.parse("2026-10-30T10:00:00.000Z");
const STOP_LINE = "You've hit your limit · resets 3pm";

interface World {
  now: number;
  resumeOn: boolean;
  shell: OrchestrationThreadShell | null;
  limits: PlanLimits;
  commands: Array<{ readonly type: string; readonly [key: string]: unknown }>;
}

const newWorld = (): World => ({
  now: START,
  resumeOn: true,
  shell: {
    id: threadId,
    archivedAt: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" },
    session: {
      threadId,
      status: "ready",
      providerName: "claudeAgent",
      activeTurnId: null,
      lastError: null,
      updatedAt: new Date(START).toISOString(),
      runtimeMode: "full-access",
    },
    latestTurn: { turnId: turn, state: "completed" },
  } as unknown as OrchestrationThreadShell,
  limits: {
    accounts: [
      {
        id: "claude:me@x.y",
        provider: "claude",
        checkedAt: new Date(START).toISOString(),
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "5-hour",
            usedPercent: 100,
            resetsAt: new Date(START + 90 * 60_000).toISOString(),
          },
        ],
      },
    ],
  },
  commands: [],
});

const serviceFor = (world: World) =>
  makePlanResume({ now: () => world.now }).pipe(
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
        Layer.mock(ServerSettingsService)({
          getSettings: Effect.sync(() => ({ resumeAfterPlanLimit: world.resumeOn })) as never,
        }),
        Layer.mock(PlanLimitsService)({
          read: () => Effect.sync(() => world.limits),
        }),
      ),
    ),
  );

const insertMessage = (input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const createdAt = new Date(input.at).toISOString();
    yield* sql`
      INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES
        (${input.id}, ${threadId}, ${turn}, ${input.role}, ${input.text}, 0, ${createdAt}, ${createdAt})
    `;
  });

const finalReply = {
  type: "thread.message-sent",
  aggregateId: threadId,
  payload: { role: "assistant", streaming: false },
} as unknown as OrchestrationEvent;

const personWrites = {
  type: "thread.turn-start-requested",
  aggregateId: threadId,
  commandId: "cmd-person",
  payload: {},
} as unknown as OrchestrationEvent;

const reset = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`DELETE FROM plan_resumes`;
  yield* sql`DELETE FROM projection_thread_messages`;
});

/** A request, and Claude Code's stop line as its short answer. */
const chatStopped = (world: World) =>
  Effect.gen(function* () {
    yield* reset;
    yield* insertMessage({ id: "m-1", role: "user", text: "Fix it", at: world.now - 5000 });
    yield* insertMessage({ id: "a-1", role: "assistant", text: STOP_LINE, at: world.now - 1000 });
  });

const activityKinds = (world: World) =>
  world.commands.flatMap((command) =>
    command.type === "thread.activity.append"
      ? [(command.activity as { readonly kind: string }).kind]
      : [],
  );

const turnStarts = (world: World) =>
  world.commands.filter((command) => command.type === "thread.turn.start");

const pastReset = (world: World) => {
  world.now = START + 90 * 60_000 + PLAN_RESUME_GRACE_MS + 1;
  world.limits = { accounts: [] };
};

const layer = it.layer(NodeSqliteClient.layerMemory());

layer("PlanResumeService", (it) => {
  it.effect("schedules at the plan's reset and says so in the chat", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* chatStopped(world);
      const service = yield* serviceFor(world);
      yield* service.onDomainEvent(finalReply);

      assert.deepStrictEqual(activityKinds(world), [PLAN_RESUME_SCHEDULED_ACTIVITY]);
      const activity = world.commands[0]?.activity as {
        readonly payload: { readonly resumeAt: string; readonly source: string };
      };
      assert.strictEqual(activity.payload.source, "plan");
      assert.strictEqual(
        Date.parse(activity.payload.resumeAt),
        START + 90 * 60_000 + PLAN_RESUME_GRACE_MS,
      );
    }),
  );

  it.effect("goes on once after the reset, even after a daemon restart", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* chatStopped(world);
      const before = yield* serviceFor(world);
      yield* before.onDomainEvent(finalReply);

      // Before the reset nothing happens.
      yield* before.sweep;
      assert.strictEqual(turnStarts(world).length, 0);

      pastReset(world);
      const afterRestart = yield* serviceFor(world);
      yield* afterRestart.sweep;
      yield* afterRestart.sweep;

      const starts = turnStarts(world);
      assert.strictEqual(starts.length, 1);
      assert.isTrue(String(starts[0]?.commandId).startsWith(PLAN_RESUME_MESSAGE_PREFIX));
      assert.include(activityKinds(world), PLAN_RESUME_ENDED_ACTIVITY);
    }),
  );

  it.effect("one try: the limit again right after a resume is left to the person", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* chatStopped(world);
      const service = yield* serviceFor(world);
      yield* service.onDomainEvent(finalReply);
      pastReset(world);
      yield* service.sweep;
      const resumeMessage = turnStarts(world)[0]?.message as { readonly messageId: string };

      // The continuation ran and hit the limit again.
      yield* insertMessage({
        id: resumeMessage.messageId,
        role: "user",
        text: "(Uno Work) go on",
        at: world.now + 1000,
      });
      yield* insertMessage({ id: "a-2", role: "assistant", text: STOP_LINE, at: world.now + 2000 });
      world.now += 3000;
      world.commands.length = 0;
      yield* service.onDomainEvent(finalReply);

      assert.deepStrictEqual(activityKinds(world), []);
    }),
  );

  it.effect("a person's message ends the wait", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* chatStopped(world);
      const service = yield* serviceFor(world);
      yield* service.onDomainEvent(finalReply);
      yield* service.onDomainEvent(personWrites);

      assert.deepStrictEqual(activityKinds(world), [
        PLAN_RESUME_SCHEDULED_ACTIVITY,
        PLAN_RESUME_ENDED_ACTIVITY,
      ]);
      pastReset(world);
      yield* service.sweep;
      assert.strictEqual(turnStarts(world).length, 0);
    }),
  );

  it.effect("a message the daemon missed while it was down ends the wait too", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* chatStopped(world);
      const service = yield* serviceFor(world);
      yield* service.onDomainEvent(finalReply);
      yield* insertMessage({ id: "m-2", role: "user", text: "Other", at: world.now + 1000 });

      pastReset(world);
      yield* service.sweep;

      assert.strictEqual(turnStarts(world).length, 0);
      assert.include(activityKinds(world), PLAN_RESUME_ENDED_ACTIVITY);
    }),
  );

  it.effect("Cancel holds: the same stop seen again doesn't schedule it back", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* chatStopped(world);
      const service = yield* serviceFor(world);
      yield* service.onDomainEvent(finalReply);
      assert.isTrue(yield* service.cancel(threadId, "person-cancelled"));
      yield* service.onDomainEvent(finalReply);

      assert.deepStrictEqual(activityKinds(world), [
        PLAN_RESUME_SCHEDULED_ACTIVITY,
        PLAN_RESUME_ENDED_ACTIVITY,
      ]);
      assert.isFalse(yield* service.cancel(threadId, "person-cancelled"));
    }),
  );

  it.effect("the setting off: nothing scheduled, chats waiting stop waiting", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* chatStopped(world);
      const service = yield* serviceFor(world);
      world.resumeOn = false;
      yield* service.onDomainEvent(finalReply);
      assert.deepStrictEqual(activityKinds(world), []);

      world.resumeOn = true;
      yield* service.onDomainEvent(finalReply);
      world.resumeOn = false;
      yield* service.sweep;
      assert.deepStrictEqual(activityKinds(world), [
        PLAN_RESUME_SCHEDULED_ACTIVITY,
        PLAN_RESUME_ENDED_ACTIVITY,
      ]);
      assert.strictEqual(turnStarts(world).length, 0);
    }),
  );

  it.effect("no reset time anywhere: no schedule, no blind try", () =>
    Effect.gen(function* () {
      const world = newWorld();
      world.limits = { accounts: [] };
      yield* reset;
      yield* insertMessage({ id: "m-1", role: "user", text: "Fix", at: world.now - 5000 });
      yield* insertMessage({
        id: "a-1",
        role: "assistant",
        text: "You've hit your limit.",
        at: world.now - 1000,
      });
      const service = yield* serviceFor(world);
      yield* service.onDomainEvent(finalReply);
      assert.deepStrictEqual(activityKinds(world), []);
    }),
  );

  it.effect("the weekly window filled meanwhile: waits for it, the try isn't wasted", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* chatStopped(world);
      const service = yield* serviceFor(world);
      yield* service.onDomainEvent(finalReply);

      world.now = START + 90 * 60_000 + PLAN_RESUME_GRACE_MS + 1;
      const weekly = new Date(world.now + 600 * 60_000).toISOString();
      world.limits = {
        accounts: [
          {
            id: "claude:me@x.y",
            provider: "claude",
            windows: [
              { id: "seven_day", kind: "weekly", label: "W", usedPercent: 100, resetsAt: weekly },
            ],
          },
        ],
      };
      yield* service.sweep;

      assert.strictEqual(turnStarts(world).length, 0);
      assert.deepStrictEqual(activityKinds(world), [
        PLAN_RESUME_SCHEDULED_ACTIVITY,
        PLAN_RESUME_SCHEDULED_ACTIVITY,
      ]);
    }),
  );

  it.effect("leaves a harness without a plan of its own alone", () =>
    Effect.gen(function* () {
      const world = newWorld();
      yield* chatStopped(world);
      const shell = world.shell as unknown as { session: { providerName: string } };
      shell.session.providerName = "uno";
      const service = yield* serviceFor(world);
      yield* service.onDomainEvent(finalReply);
      assert.deepStrictEqual(activityKinds(world), []);
    }),
  );
});
