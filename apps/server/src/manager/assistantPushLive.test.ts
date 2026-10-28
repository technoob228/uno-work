/**
 * The assistant's work update end to end: the real Telegram connector (fake
 * Bot API on localhost), the real push service, a fake harness for the
 * assistant's conversation and a hand-driven chat it handed work to, on a
 * clock 60× faster than the wall clock.
 *
 * - Telegram: the person asks, the assistant hands off ("Handed off", quoting
 *   the message) and ends its turn; when the work chat finishes the assistant
 *   gets ONE notice turn (system origin) and its report reaches the same
 *   Telegram chat — not a reply to anything the person wrote.
 * - Desktop: the request came from the app; the notice turn starts straight
 *   in the conversation once it is idle, nothing goes to Telegram.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "@effect/vitest";
import {
  ASSISTANT_PROJECT_ID,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  assistantTokenLabel,
  type OrchestrationCommand,
  type OrchestrationCommandOrigin,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { Clock, Effect, Layer, Option, PubSub, Stream } from "effect";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as nodePath from "node:path";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorBindingRepositoryLive } from "../persistence/Layers/ManagerConnectorBindings.ts";
import { ManagerConnectorRepositoryLive } from "../persistence/Layers/ManagerConnectors.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ManagerCapabilityTokenRepository } from "../persistence/Services/ManagerCapabilityTokens.ts";
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CONTROL_PLANE_URL_OVERRIDE_ENV } from "../workspaceRegistry/unoCloudParse.ts";
import { PUSH_NOTICE_MARKER } from "./assistantPush.ts";
import { fastClock, iso, MINUTE, real, waitFor, World } from "./connectorRepliesTestkit.ts";
import { AssistantPushServiceLive } from "./Layers/AssistantPush.ts";
import { ManagerSlackService } from "./Layers/SlackConnector.ts";
import { ManagerTelegramServiceLive } from "./Layers/TelegramConnector.ts";
import { AssistantPushService } from "./Services/AssistantPush.ts";

// ── Fake Bot API ─────────────────────────────────────────────────────────

const RELAY = "tgr_" + "b".repeat(40);
const CHAT = 5151;

let updates: Array<{ update_id: number; message: unknown }> = [];
let sent: Array<{ text: string; replyTo: number | null }> = [];
let nextUpdateId = 1;
let nextMessageId = 100;
let server: http.Server;

const say = (text: string) => {
  const messageId = nextMessageId++;
  updates.push({
    update_id: nextUpdateId++,
    message: {
      message_id: messageId,
      chat: { id: CHAT, type: "private" },
      from: { id: CHAT, is_bot: false, language_code: "ru" },
      text,
    },
  });
  return messageId;
};

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://relay.test");
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const method = /\/bot[^/]+\/(\w+)$/.exec(url.pathname)?.[1] ?? "";
      response.setHeader("content-type", "application/json");
      const reply = (result: unknown) => response.end(JSON.stringify({ ok: true, result }));
      switch (method) {
        case "getMe":
          return reply({ id: 1, is_bot: true, username: "uno_test_bot" });
        case "getUpdates": {
          const offset = Number(url.searchParams.get("offset") ?? "0");
          const pending = updates.filter((update) => update.update_id >= offset);
          setTimeout(() => reply(pending), pending.length > 0 ? 0 : 100);
          return;
        }
        case "sendMessage": {
          const payload = JSON.parse(body) as {
            text: string;
            reply_parameters?: { message_id: number };
          };
          sent.push({ text: payload.text, replyTo: payload.reply_parameters?.message_id ?? null });
          return reply({ message_id: nextMessageId++ });
        }
        default:
          return reply(true);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv(
    CONTROL_PLANE_URL_OVERRIDE_ENV,
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── The conversation (fake harness) and the work chat (by hand) ─────────

const mainThreadId = ThreadId.make("thread-uno-main");
const childThreadId = ThreadId.make("thread-fix-login");
const TOKEN_ID = "tok-uno";

const mainShell = {
  id: mainThreadId,
  projectId: ASSISTANT_PROJECT_ID,
  title: "Uno",
  assistantRole: "chat",
  spawnedByThreadId: null,
  archivedAt: null,
  deletedAt: null,
  modelSelection: { instanceId: "hermes", model: "uno/smart" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
};

interface Child {
  shell: Record<string, unknown>;
  messages: Array<OrchestrationThread["messages"][number]>;
}

const makeChild = (): Child => ({
  shell: {
    id: childThreadId,
    projectId: "project-shop",
    title: "Fix login",
    assistantRole: "spawned",
    spawnedByThreadId: null,
    archivedAt: null,
    session: {
      threadId: childThreadId,
      status: "running",
      activeTurnId: "child-turn-1",
      updatedAt: iso(),
      lastError: null,
    },
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtimeMode: "full-access",
    interactionMode: "default",
    updatedAt: iso(),
  },
  messages: [],
});

let world = new World();
let child = makeChild();
let events = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());
let dispatchedOrigins: Array<{ text: string; origin: OrchestrationCommandOrigin | undefined }> = [];
let workspaceRoot = "";
let tmpDir = "";

const publish = (event: Record<string, unknown>) =>
  PubSub.publish(events, event as unknown as OrchestrationEvent);

/** What `create_thread` with the assistant's token makes the engine emit. */
const handOff = (requestedAt: string) =>
  publish({
    sequence: 1,
    eventId: EventId.make(`evt-${requestedAt}`),
    aggregateKind: "thread",
    aggregateId: childThreadId,
    occurredAt: requestedAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    type: "thread.turn-start-requested",
    payload: {
      threadId: childThreadId,
      messageId: MessageId.make("child-msg-1"),
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: requestedAt,
    },
    metadata: { origin: { kind: "manager", tokenId: TOKEN_ID } },
  });

/** The work chat finishes its turn: turn row, answer, idle session, an event. */
const finishChild = (requestedAt: string, turns: typeof ProjectionTurnRepository.Service) =>
  Effect.gen(function* () {
    const done = iso();
    yield* turns.upsertByTurnId({
      threadId: childThreadId,
      turnId: TurnId.make("child-turn-1"),
      pendingMessageId: MessageId.make("child-msg-1"),
      sourceProposedPlanThreadId: null,
      sourceProposedPlanId: null,
      assistantMessageId: MessageId.make("child-answer"),
      state: "completed",
      requestedAt,
      startedAt: requestedAt,
      completedAt: done,
      checkpointTurnCount: null,
      checkpointRef: null,
      checkpointStatus: "ready",
      checkpointFiles: [{ path: "src/login.ts", kind: "modified", additions: 3, deletions: 1 }],
    } as never);
    child.messages.push({
      id: MessageId.make("child-answer"),
      role: "assistant",
      text: "Fixed the login redirect; tests pass.",
      turnId: TurnId.make("child-turn-1"),
      streaming: false,
      createdAt: done,
      updatedAt: done,
    });
    child.shell = {
      ...child.shell,
      session: {
        ...(child.shell.session as object),
        status: "ready",
        activeTurnId: null,
        updatedAt: done,
      },
      updatedAt: done,
    };
    yield* publish({
      sequence: 2,
      eventId: EventId.make(`evt-done-${done}`),
      aggregateKind: "thread",
      aggregateId: childThreadId,
      occurredAt: done,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      type: "thread.session-set",
      payload: { threadId: childThreadId, session: child.shell.session },
      metadata: {},
    });
  });

const makeLayer = (dbPath: string) => {
  const persistence = makeSqlitePersistenceLive(dbPath);
  const repositories = Layer.mergeAll(
    ManagerConnectorRepositoryLive,
    ManagerConnectorBindingRepositoryLive,
    ProjectionPendingApprovalRepositoryLive,
    ProjectionTurnRepositoryLive,
  ).pipe(Layer.provideMerge(persistence));
  const engine = Layer.mock(OrchestrationEngineService)({
    readEvents: () => Stream.empty,
    get streamDomainEvents() {
      return Stream.fromPubSub(events);
    },
    dispatch: (command: OrchestrationCommand, options) =>
      Effect.sync(() => {
        if (command.type === "thread.turn.start") {
          dispatchedOrigins.push({ text: command.message.text, origin: options?.origin });
        }
        world.dispatch(command);
        return { sequence: 1 };
      }),
  });
  const projections = Layer.mock(ProjectionSnapshotQuery)({
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: [],
        threads: [mainShell, child.shell],
        updatedAt: iso(),
      } as never),
    getProjectShellById: (id) =>
      Effect.succeed(
        id === "project-shop" ? Option.some({ id, title: "Shop" } as never) : Option.none(),
      ),
    getThreadShellById: (id) =>
      Effect.succeed(
        id === mainThreadId
          ? Option.some({ ...mainShell, session: world.session } as never)
          : id === childThreadId
            ? Option.some(child.shell as never)
            : Option.none(),
      ),
    getThreadDetailById: (id) =>
      Effect.succeed(
        id === mainThreadId
          ? Option.some(world.detail())
          : id === childThreadId
            ? Option.some({
                id,
                messages: child.messages,
                activities: [],
                session: child.shell.session,
              } as never)
            : Option.none(),
      ),
    getThreadCheckpointContext: () =>
      Effect.succeed(Option.some({ workspaceRoot, worktreePath: null } as never)),
  });
  const tokens = Layer.mock(ManagerCapabilityTokenRepository)({
    list: () =>
      Effect.succeed([
        { tokenId: TOKEN_ID, label: assistantTokenLabel(ASSISTANT_PROJECT_ID) },
      ] as never),
  });
  const slack = Layer.mock(ManagerSlackService)({
    enqueueSystemTurn: () => Effect.succeed("failed" as const),
  });
  return AssistantPushServiceLive.pipe(
    Layer.provideMerge(ManagerTelegramServiceLive),
    Layer.provideMerge(repositories),
    Layer.provide(
      Layer.mergeAll(
        engine,
        projections,
        tokens,
        slack,
        ServerSettingsService.layerTest({}),
        ServerConfig.layerTest(process.cwd(), { prefix: "uno-push-test-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

const run = <A, E>(
  dbPath: string,
  body: Effect.Effect<
    A,
    E,
    ManagerConnectorRepository | ProjectionTurnRepository | AssistantPushService
  >,
) =>
  Effect.gen(function* () {
    world.turns = yield* ProjectionTurnRepository;
    return yield* body;
  }).pipe(Effect.provide(makeLayer(dbPath)), Effect.provideService(Clock.Clock, fastClock));

const connect = Effect.gen(function* () {
  const repository = yield* ManagerConnectorRepository;
  yield* repository.upsert({
    projectId: ASSISTANT_PROJECT_ID,
    kind: "telegram",
    config: {
      botToken: `unorelay:${RELAY}`,
      allowedChatIds: [String(CHAT)],
      ownerUserIds: [String(CHAT)],
      enabled: true,
      defaultModelSelection: null,
    },
    updatedAt: new Date().toISOString(),
  });
});

/** The handed-off chat is watched (the event is handled asynchronously). */
const watched = (push: typeof AssistantPushService.Service) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (yield* push.reportsOutcomeOf(childThreadId)) return true;
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
    }
    return false;
  });

const notices = () =>
  dispatchedOrigins.filter((entry) => entry.text.startsWith(PUSH_NOTICE_MARKER));

beforeEach(() => {
  world.stop();
  world = new World();
  world.threadId = mainThreadId;
  world.script = (text) =>
    text.startsWith(PUSH_NOTICE_MARKER)
      ? { durationMs: 20_000, answer: "ответ: «Fix login» готов, тесты зелёные" }
      : { durationMs: 5_000, answer: "ответ: Передал в «Fix login»" };
  world.start();
  child = makeChild();
  events = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());
  dispatchedOrigins = [];
  updates = [];
  sent = [];
  tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-push-live-"));
  workspaceRoot = nodePath.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
});

it.live(
  "Telegram: handed off in one turn, then the checked report reaches the same chat",
  () =>
    run(
      nodePath.join(tmpDir, "state.sqlite"),
      Effect.gen(function* () {
        yield* connect;
        const asked = say("почини логин в магазине");
        // The assistant's turn runs: it calls create_thread meanwhile.
        expect(yield* waitFor(() => world.running !== null, real(2 * MINUTE))).toBe(true);
        const requestedAt = iso();
        yield* handOff(requestedAt);
        // "Handed off" quotes the person's message and the turn is over.
        expect(
          yield* waitFor(() => sent.some((entry) => entry.text.includes("Передал")), real(MINUTE)),
        ).toBe(true);
        expect(sent.find((entry) => entry.text.includes("Передал"))?.replyTo).toBe(asked);

        // The work chat finishes much later.
        const turns = yield* ProjectionTurnRepository;
        const push = yield* AssistantPushService;
        expect(yield* watched(push)).toBe(true);
        yield* finishChild(requestedAt, turns);

        expect(
          yield* waitFor(
            () => sent.some((entry) => entry.text.includes("готов")),
            real(3 * MINUTE),
          ),
        ).toBe(true);
        const report = sent.find((entry) => entry.text.includes("готов"));
        // Its own message, not a reply to anything the person wrote.
        expect(report?.replyTo).toBeNull();
        // One notice turn, system origin, with the facts and the wrapped answer.
        expect(notices()).toHaveLength(1);
        const notice = notices()[0]!;
        expect(notice.origin).toMatchObject({ kind: "system", component: "assistant-push" });
        expect(notice.text).toContain("«Fix login» (threadId thread-fix-login) — finished");
        expect(notice.text).toContain("1 files changed");
        expect(notice.text).toContain(
          "<untrusted_thread_output>Fixed the login redirect; tests pass.</untrusted_thread_output>",
        );
        // Nobody wrote, so no "Got it, I'll answer after…" and no progress notes.
        expect(sent.filter((entry) => /^(Получил|Работаю|Всё ещё)/.test(entry.text))).toEqual([]);

        // More events of the finished chat: still one notice (dedupe).
        yield* finishChild(requestedAt, turns);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, real(MINUTE))));
        expect(notices()).toHaveLength(1);
        // The notice turn itself started no watch (no loop).
        expect(world.turnCount).toBe(2);
      }),
    ),
  60_000,
);

it.live(
  "desktop: the request came from the app, the notice turn starts in the conversation itself",
  () =>
    run(
      nodePath.join(tmpDir, "state.sqlite"),
      Effect.gen(function* () {
        // The push is listening once the daemon is up.
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 200)));
        const requestedAt = iso();
        yield* handOff(requestedAt);
        expect(yield* watched(yield* AssistantPushService)).toBe(true);
        yield* finishChild(requestedAt, yield* ProjectionTurnRepository);
        expect(yield* waitFor(() => notices().length > 0, real(3 * MINUTE))).toBe(true);
        expect(notices()[0]?.origin).toMatchObject({ kind: "system" });
        expect(
          yield* waitFor(() => world.turnCount === 1 && world.running === null, real(2 * MINUTE)),
        ).toBe(true);
        expect(sent).toEqual([]);
        expect(notices()).toHaveLength(1);
      }),
    ),
  60_000,
);
