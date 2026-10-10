/**
 * The real Telegram connector, long-polling a person's OWN bot, against a
 * fake Telegram that refuses `getUpdates` while a webhook is set (as the real
 * one does, HTTP 409), with a clock that runs 60× faster.
 *
 * The case: a later Uno Work version puts such a bot on a webhook (so a
 * message wakes a sleeping computer). A computer that goes back to a version
 * that only polls would then hear 409 forever and the bot would be silent
 * even while the computer is awake. This version removes a webhook Uno Work
 * itself set and polls on; a webhook of the person's other service is left
 * alone and named as the reason.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "@effect/vitest";
import { ASSISTANT_PROJECT_ID, ThreadId } from "@t3tools/contracts";
import { Clock, Effect, Layer, Option, Stream } from "effect";
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
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TELEGRAM_API_URL_OVERRIDE_ENV } from "./channelRelay.ts";
import { fastClock, MINUTE, real, waitFor, World } from "./connectorRepliesTestkit.ts";
import { ManagerTelegramService, ManagerTelegramServiceLive } from "./Layers/TelegramConnector.ts";
import {
  FOREIGN_TELEGRAM_WEBHOOK_MESSAGE,
  TELEGRAM_WEBHOOK_PATH_PREFIX,
  telegramWebhookHookId,
} from "./telegramWebhook.ts";

const BOT = "123456:AAExampleExampleExampleExampleExample";
const CHAT = 4242;
/** What a later Uno Work version set — on an address this computer no longer has. */
const OUR_WEBHOOK = `https://old-name-bcdfghjkmn.app.uno4.dev${TELEGRAM_WEBHOOK_PATH_PREFIX}${telegramWebhookHookId(BOT)}`;
const THEIR_WEBHOOK = "https://my-own-service.example/api/telegram/webhook/mybot";

// ── Fake Telegram ────────────────────────────────────────────────────────

interface Update {
  readonly update_id: number;
  readonly message: { readonly message_id: number } & Record<string, unknown>;
}
interface Sent {
  readonly text: string;
  readonly replyTo: number | null;
}

let webhookUrl = "";
/** Updates Telegram has not been told to forget (unconfirmed). */
let held: Array<Update> = [];
let calls: Array<{ readonly method: string; readonly body: Record<string, unknown> }> = [];
let sent: Array<Sent> = [];
let nextUpdateId = 1;
let nextMessageId = 100;
let server: http.Server;

const say = (text: string): Update => {
  const update: Update = {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++,
      chat: { id: CHAT, type: "private" },
      from: { id: CHAT, is_bot: false, language_code: "ru" },
      text,
    },
  };
  held.push(update);
  return update;
};

const callsOf = (method: string) => calls.filter((call) => call.method === method);

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://telegram.test");
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw.startsWith("{") ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const method = /\/bot[^/]+\/(\w+)$/.exec(url.pathname)?.[1] ?? "";
      calls.push({ method, body });
      response.setHeader("content-type", "application/json");
      const reply = (result: unknown) => response.end(JSON.stringify({ ok: true, result }));
      switch (method) {
        case "getMe":
          return reply({ id: 1, is_bot: true, username: "my_own_bot" });
        case "getWebhookInfo":
          return reply({ url: webhookUrl, pending_update_count: held.length });
        case "setWebhook":
          webhookUrl = String(body["url"] ?? "");
          return reply(true);
        case "deleteWebhook":
          webhookUrl = "";
          if (body["drop_pending_updates"] === true) held = [];
          return reply(true);
        case "getUpdates": {
          if (webhookUrl.length > 0) {
            response.statusCode = 409;
            return response.end(
              JSON.stringify({
                ok: false,
                error_code: 409,
                description:
                  "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first",
              }),
            );
          }
          // An offset past an update confirms it: Telegram forgets it.
          const offset = Number(url.searchParams.get("offset") ?? "0");
          if (offset > 0) held = held.filter((update) => update.update_id >= offset);
          const batch = [...held];
          setTimeout(() => reply(batch), batch.length > 0 ? 0 : 100);
          return;
        }
        case "sendMessage": {
          const payload = body as { text?: string; reply_parameters?: { message_id: number } };
          sent.push({
            text: payload.text ?? "",
            replyTo: payload.reply_parameters?.message_id ?? null,
          });
          return reply({ message_id: nextMessageId++ });
        }
        default:
          return reply(true);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv(
    TELEGRAM_API_URL_OVERRIDE_ENV,
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── The daemon ───────────────────────────────────────────────────────────

const mainThreadId = ThreadId.make("thread-uno-main");
let workspaceRoot = "";
let world = new World();

const mainShell = {
  id: mainThreadId,
  projectId: ASSISTANT_PROJECT_ID,
  title: "Uno",
  assistantRole: "chat",
  archivedAt: null,
  deletedAt: null,
  modelSelection: { instanceId: "hermes", model: "uno/smart" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
};

const makeLayer = (dbPath: string) => {
  const persistence = makeSqlitePersistenceLive(dbPath);
  const repositories = Layer.mergeAll(
    ManagerConnectorRepositoryLive,
    ManagerConnectorBindingRepositoryLive,
    ProjectionPendingApprovalRepositoryLive,
    ProjectionTurnRepositoryLive,
  ).pipe(Layer.provideMerge(persistence));
  return ManagerTelegramServiceLive.pipe(
    Layer.provideMerge(repositories),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              world.dispatch(command);
              return { sequence: 1 };
            }),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [],
              threads: [mainShell],
              updatedAt: "2026-10-10T00:00:00.000Z",
            } as never),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getThreadShellById: (id) =>
            Effect.succeed(id === mainThreadId ? Option.some(mainShell as never) : Option.none()),
          getThreadDetailById: (id) =>
            Effect.succeed(id === mainThreadId ? Option.some(world.detail()) : Option.none()),
          getThreadCheckpointContext: () =>
            Effect.succeed(Option.some({ workspaceRoot, worktreePath: null } as never)),
        }),
        ServerSettingsService.layerTest({}),
        ServerConfig.layerTest(process.cwd(), { prefix: "uno-tg-heal-test-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

/** Run `body` with the connector up (a daemon run); it stops when `body` ends. */
const daemonRun = <A, E>(
  dbPath: string,
  body: Effect.Effect<A, E, ManagerConnectorRepository | ManagerTelegramService>,
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
      botToken: BOT,
      allowedChatIds: [String(CHAT)],
      ownerUserIds: [String(CHAT)],
      enabled: true,
      defaultModelSelection: null,
    },
    updatedAt: new Date().toISOString(),
  });
});

const answers = () => sent.filter((entry) => entry.text.startsWith("ответ:"));

let tmpDir = "";
beforeEach(() => {
  world.stop();
  world = new World();
  world.threadId = mainThreadId;
  world.script = (text) => ({ durationMs: MINUTE, answer: `ответ: ${text.split("\n")[0]}` });
  world.start();
  webhookUrl = "";
  held = [];
  calls = [];
  sent = [];
  tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-tg-heal-"));
  workspaceRoot = nodePath.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
});

it.live(
  "a webhook Uno Work set is removed, pending messages are kept and answered once, polling goes on",
  () =>
    Effect.gen(function* () {
      const dbPath = nodePath.join(tmpDir, "state.sqlite");
      // Before: this computer polls and answers.
      const before = yield* daemonRun(
        dbPath,
        Effect.gen(function* () {
          yield* connect;
          const asked = say("до вебхука");
          expect(yield* waitFor(() => answers().length === 1, real(10 * MINUTE))).toBe(true);
          return asked;
        }),
      );
      // In between a later version had the bot on a webhook; then the
      // computer went back to this version. Telegram still holds a message
      // nobody fetched — and offers one that was already answered.
      webhookUrl = OUR_WEBHOOK;
      held = [before];
      const whileOnWebhook = say("пока был вебхук");
      world.restart();

      yield* daemonRun(
        dbPath,
        Effect.gen(function* () {
          expect(yield* waitFor(() => answers().length === 2, real(10 * MINUTE))).toBe(true);
          expect(webhookUrl).toBe("");
          // Polling simply goes on.
          const after = say("после");
          expect(yield* waitFor(() => answers().length === 3, real(10 * MINUTE))).toBe(true);
          yield* Effect.sleep("3 minutes");
          expect(answers().map((entry) => [entry.text, entry.replyTo])).toEqual([
            ["ответ: до вебхука", before.message.message_id],
            ["ответ: пока был вебхук", whileOnWebhook.message.message_id],
            ["ответ: после", after.message.message_id],
          ]);
          const telegram = yield* ManagerTelegramService;
          const status = yield* telegram.getRuntimeStatus(ASSISTANT_PROJECT_ID);
          expect(status.lastError).toBeNull();
          expect(status.health?.status).toBe("connected");
        }),
      );
      // Removed once, without throwing away what Telegram was holding; this
      // version never sets a webhook itself.
      expect(callsOf("deleteWebhook").map((call) => call.body["drop_pending_updates"])).toEqual([
        false,
      ]);
      expect(callsOf("setWebhook")).toEqual([]);
    }),
  60_000,
);

it.live(
  "a webhook of the person's other service is left alone, and the connector says why the bot is silent",
  () =>
    Effect.gen(function* () {
      webhookUrl = THEIR_WEBHOOK;
      const unanswered = say("кому это?");
      yield* daemonRun(
        nodePath.join(tmpDir, "state.sqlite"),
        Effect.gen(function* () {
          yield* connect;
          const telegram = yield* ManagerTelegramService;
          let status = yield* telegram.getRuntimeStatus(ASSISTANT_PROJECT_ID);
          for (let tries = 0; tries < 100 && status.lastError === null; tries += 1) {
            yield* Effect.sleep("10 seconds");
            status = yield* telegram.getRuntimeStatus(ASSISTANT_PROJECT_ID);
          }
          expect(status.lastError).toBe(FOREIGN_TELEGRAM_WEBHOOK_MESSAGE);
          expect(status.health?.status).toBe("provider_unavailable");
          expect(status.health?.lastError).toBe(FOREIGN_TELEGRAM_WEBHOOK_MESSAGE);
        }),
      );
      expect(webhookUrl).toBe(THEIR_WEBHOOK);
      expect(callsOf("deleteWebhook")).toEqual([]);
      expect(callsOf("setWebhook")).toEqual([]);
      expect(held).toEqual([unanswered]);
      expect(sent).toEqual([]);
    }),
  60_000,
);
