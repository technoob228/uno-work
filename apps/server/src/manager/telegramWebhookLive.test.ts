/**
 * The real Telegram connector with the person's OWN bot on an economy
 * computer, against a fake Telegram (Bot API + webhook delivery) and a fake
 * console, with a clock that runs 60× faster.
 *
 * The case (ICP pass 09.10, path r3-teammate): the computer sleeps after ten
 * idle minutes, the daemon is frozen, a long-polling bot hears nothing and
 * stays silent until somebody opens Uno Work. The fix: on an economy computer
 * Telegram delivers to the computer's own address, which wakes it. Here the
 * "address" is the connector's `receiveWebhookUpdate` (what the HTTP route
 * calls); the wake itself is the node's job and is not in this test.
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
import { CONTROL_PLANE_URL_OVERRIDE_ENV } from "../workspaceRegistry/unoCloudParse.ts";
import { TELEGRAM_API_URL_OVERRIDE_ENV } from "./channelRelay.ts";
import { fastClock, MINUTE, real, virtualNow, waitFor, World } from "./connectorRepliesTestkit.ts";
import { ManagerTelegramService, ManagerTelegramServiceLive } from "./Layers/TelegramConnector.ts";
import {
  TELEGRAM_WEBHOOK_PATH_PREFIX,
  telegramWebhookHookId,
  telegramWebhookSecret,
} from "./telegramWebhook.ts";

const BOT = "123456:AAExampleExampleExampleExampleExample";
const CHAT = 4242;
const BOX_ID = 77;
const ADDRESS = "https://mybox-bcdfghjkmn.app.uno4.dev";
const OUR_WEBHOOK = `${ADDRESS}${TELEGRAM_WEBHOOK_PATH_PREFIX}${telegramWebhookHookId(BOT)}`;

// ── Fake Telegram: Bot API + what it holds for the bot ───────────────────

interface Update {
  readonly update_id: number;
  readonly message: { readonly message_id: number } & Record<string, unknown>;
}
interface Sent {
  readonly text: string;
  readonly replyTo: number | null;
}

let webhook: { url: string; secret: string } | null = null;
/** Updates Telegram has not been told to forget (unconfirmed). */
let held: Array<Update> = [];
let lastErrorDate: number | undefined;
let calls: Array<string> = [];
let sent: Array<Sent> = [];
let nextUpdateId = 1;
let nextMessageId = 100;
/** What the console answers for `GET /api/v1/boxes/77`; null — the console is down. */
let box: Record<string, unknown> | null = null;
let boxReads = 0;
let server: http.Server;

const newUpdate = (text: string): Update => ({
  update_id: nextUpdateId++,
  message: {
    message_id: nextMessageId++,
    chat: { id: CHAT, type: "private" },
    from: { id: CHAT, is_bot: false, language_code: "ru" },
    text,
  },
});

const count = (method: string) => calls.filter((call) => call === method).length;

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake.test");
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      response.setHeader("content-type", "application/json");
      if (url.pathname === `/api/v1/boxes/${BOX_ID}`) {
        boxReads += 1;
        if (box === null) {
          response.statusCode = 502;
          return response.end("{}");
        }
        return response.end(JSON.stringify(box));
      }
      const method = /\/bot[^/]+\/(\w+)$/.exec(url.pathname)?.[1] ?? "";
      calls.push(method);
      const reply = (result: unknown) => response.end(JSON.stringify({ ok: true, result }));
      const json = () => (body.length > 0 ? (JSON.parse(body) as Record<string, unknown>) : {});
      switch (method) {
        case "getMe":
          return reply({ id: 1, is_bot: true, username: "my_own_bot" });
        case "getWebhookInfo":
          return reply({
            url: webhook?.url ?? "",
            pending_update_count: held.length,
            ...(lastErrorDate !== undefined ? { last_error_date: lastErrorDate } : {}),
          });
        case "setWebhook": {
          const payload = json() as { url: string; secret_token: string };
          webhook = { url: payload.url, secret: payload.secret_token };
          return reply(true);
        }
        case "deleteWebhook":
          webhook = null;
          return reply(true);
        case "getUpdates": {
          if (webhook !== null) {
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
          const wait = Number(url.searchParams.get("timeout") ?? "0") > 0 && batch.length === 0;
          setTimeout(() => reply(batch), wait ? 100 : 0);
          return;
        }
        case "sendMessage": {
          const payload = json() as { text: string; reply_parameters?: { message_id: number } };
          sent.push({ text: payload.text, replyTo: payload.reply_parameters?.message_id ?? null });
          return reply({ message_id: nextMessageId++ });
        }
        default:
          return reply(true);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv(CONTROL_PLANE_URL_OVERRIDE_ENV, base);
  vi.stubEnv(TELEGRAM_API_URL_OVERRIDE_ENV, base);
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

const makeLayer = (dbPath: string, cloudComputer: boolean) => {
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
        ServerSettingsService.layerTest(
          cloudComputer ? { uno: { boxToken: "uno_agt_test_machine", boxId: BOX_ID } } : {},
        ),
        ServerConfig.layerTest(process.cwd(), { prefix: "uno-tg-webhook-test-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

/** Run `body` with the connector up (a daemon run); it stops when `body` ends. */
const daemonRun = <A, E>(
  dbPath: string,
  body: Effect.Effect<A, E, ManagerConnectorRepository | ManagerTelegramService>,
  options: { readonly cloudComputer?: boolean } = {},
) =>
  Effect.gen(function* () {
    world.turns = yield* ProjectionTurnRepository;
    return yield* body;
  }).pipe(
    Effect.provide(makeLayer(dbPath, options.cloudComputer ?? true)),
    Effect.provideService(Clock.Clock, fastClock),
  );

const saveBot = (enabled: boolean) =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    yield* repository.upsert({
      projectId: ASSISTANT_PROJECT_ID,
      kind: "telegram",
      config: {
        botToken: BOT,
        allowedChatIds: [String(CHAT)],
        ownerUserIds: [String(CHAT)],
        enabled,
        defaultModelSelection: null,
      },
      updatedAt: new Date().toISOString(),
    });
  });
const connect = saveBot(true);

/**
 * Telegram delivering one update to the webhook, as the HTTP route passes it
 * on. Like Telegram, it forgets the update only when told "accepted" and
 * notes a failure otherwise.
 */
const deliver = (update: Update, secret?: string) =>
  Effect.gen(function* () {
    const telegram = yield* ManagerTelegramService;
    if (webhook === null) throw new Error("no webhook is set");
    const receipt = yield* telegram.receiveWebhookUpdate({
      hookId: webhook.url.slice(webhook.url.lastIndexOf("/") + 1),
      secret: secret ?? webhook.secret,
      readUpdate: Effect.succeed(structuredClone(update)),
    });
    if (receipt === "accepted") {
      held = held.filter((entry) => entry.update_id !== update.update_id);
    } else {
      lastErrorDate = Math.floor(virtualNow() / 1000);
    }
    return receipt;
  });

/** A person writes to the bot: Telegram holds the update until it is taken. */
const say = (text: string) => {
  const update = newUpdate(text);
  held.push(update);
  return update;
};

const answers = () => sent.filter((entry) => entry.text.startsWith("ответ:"));
const webhookIsOurs = () => webhook?.url === OUR_WEBHOOK;

let tmpDir = "";
beforeEach(() => {
  world.stop();
  world = new World();
  world.threadId = mainThreadId;
  world.script = (text) => ({ durationMs: MINUTE, answer: `ответ: ${text.split("\n")[0]}` });
  world.start();
  webhook = null;
  held = [];
  lastErrorDate = undefined;
  calls = [];
  sent = [];
  boxReads = 0;
  box = { id: BOX_ID, url: ADDRESS, wake_on_http: true, economy: { enabled: true } };
  tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-tg-webhook-"));
  workspaceRoot = nodePath.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
});

it.live(
  "economy computer, own bot: the webhook points at the computer's address and a delivered message gets its real answer",
  () =>
    Effect.gen(function* () {
      yield* daemonRun(
        nodePath.join(tmpDir, "state.sqlite"),
        Effect.gen(function* () {
          yield* connect;
          expect(yield* waitFor(webhookIsOurs, real(2 * MINUTE))).toBe(true);
          // Telegram proves itself with a secret derived from the token; the
          // token itself is in neither the address nor the secret.
          expect(webhook?.secret).toBe(telegramWebhookSecret(BOT));
          expect(webhook?.url).not.toContain(BOT.split(":")[1]);

          const asked = say("ты спишь?");
          expect(yield* deliver(asked)).toBe("accepted");
          expect(yield* waitFor(() => answers().length > 0, real(10 * MINUTE))).toBe(true);
          expect(answers()).toEqual([
            { text: "ответ: ты спишь?", replyTo: asked.message.message_id },
          ]);

          // Not a single long poll: on a sleeping computer nobody would be asking.
          expect(count("getUpdates")).toBe(0);
          expect(webhookIsOurs()).toBe(true);
        }),
      );
    }),
  60_000,
);

it.live(
  "nobody but Telegram gets in, and a repeated delivery is answered once",
  () =>
    Effect.gen(function* () {
      yield* daemonRun(
        nodePath.join(tmpDir, "state.sqlite"),
        Effect.gen(function* () {
          yield* connect;
          expect(yield* waitFor(webhookIsOurs, real(2 * MINUTE))).toBe(true);
          const telegram = yield* ManagerTelegramService;
          const forged = newUpdate("впусти меня");
          let bodyRead = false;
          const readUpdate = Effect.sync(() => {
            bodyRead = true;
            return forged as unknown;
          });
          const hookId = telegramWebhookHookId(BOT);
          for (const attempt of [
            { hookId, secret: null },
            { hookId, secret: "guess" },
            { hookId, secret: telegramWebhookSecret("999:other-bot") },
            { hookId: "0".repeat(32), secret: telegramWebhookSecret(BOT) },
          ]) {
            expect(yield* telegram.receiveWebhookUpdate({ ...attempt, readUpdate })).toBe(
              "unknown",
            );
          }
          // The body of a stranger's request is not even read.
          expect(bodyRead).toBe(false);
          expect(
            yield* telegram.receiveWebhookUpdate({
              hookId,
              secret: telegramWebhookSecret(BOT),
              readUpdate: Effect.succeed({ not: "an update" }),
            }),
          ).toBe("invalid");

          // Telegram did not hear our 200 and delivers the same update again.
          const asked = say("один раз");
          expect(yield* deliver(asked)).toBe("accepted");
          expect(yield* deliver(asked)).toBe("accepted");
          expect(yield* waitFor(() => answers().length > 0, real(10 * MINUTE))).toBe(true);
          expect(yield* deliver(asked)).toBe("accepted");
          yield* Effect.sleep("3 minutes");
          expect(answers()).toEqual([
            { text: "ответ: один раз", replyTo: asked.message.message_id },
          ]);
          expect(world.turnCount).toBe(1);
          expect(world.dispatchedTexts.join("\n")).not.toContain("впусти меня");
        }),
      );
    }),
  60_000,
);

it.live(
  "an always-on computer, a laptop: long polling as before, no webhook",
  () =>
    Effect.gen(function* () {
      box = { id: BOX_ID, url: ADDRESS, wake_on_http: true, economy: { enabled: false } };
      yield* daemonRun(
        nodePath.join(tmpDir, "always-on.sqlite"),
        Effect.gen(function* () {
          yield* connect;
          const asked = say("привет с always-on");
          expect(yield* waitFor(() => answers().length > 0, real(10 * MINUTE))).toBe(true);
          expect(answers()[0]?.replyTo).toBe(asked.message.message_id);
        }),
      );
      expect(count("setWebhook")).toBe(0);
      expect(count("deleteWebhook")).toBe(0);
      expect(boxReads).toBeGreaterThan(0);

      // A laptop has no machine identity: the console is not even asked.
      boxReads = 0;
      sent = [];
      box = { id: BOX_ID, url: ADDRESS, wake_on_http: true, economy: { enabled: true } };
      world.stop();
      world = new World();
      world.threadId = mainThreadId;
      world.script = (text) => ({ durationMs: MINUTE, answer: `ответ: ${text.split("\n")[0]}` });
      world.start();
      yield* daemonRun(
        nodePath.join(tmpDir, "laptop.sqlite"),
        Effect.gen(function* () {
          yield* connect;
          const asked = say("привет с ноутбука");
          expect(yield* waitFor(() => answers().length > 0, real(10 * MINUTE))).toBe(true);
          expect(answers()[0]?.replyTo).toBe(asked.message.message_id);
        }),
        { cloudComputer: false },
      );
      expect(count("setWebhook")).toBe(0);
      expect(boxReads).toBe(0);
    }),
  60_000,
);

it.live(
  "the wake took too long and Telegram kept the message: the daemon fetches it itself and puts the webhook back",
  () =>
    Effect.gen(function* () {
      yield* daemonRun(
        nodePath.join(tmpDir, "state.sqlite"),
        Effect.gen(function* () {
          yield* connect;
          expect(yield* waitFor(webhookIsOurs, real(2 * MINUTE))).toBe(true);
          // Telegram tried, the address answered 503 (the computer was still
          // waking), the update stays with Telegram.
          const first = say("первое, пока спал");
          const second = say("второе, пока спал");
          lastErrorDate = Math.floor(virtualNow() / 1000);

          expect(yield* waitFor(() => answers().length >= 2, real(15 * MINUTE))).toBe(true);
          expect(answers()).toEqual([
            { text: "ответ: первое, пока спал", replyTo: first.message.message_id },
            { text: "ответ: второе, пока спал", replyTo: second.message.message_id },
          ]);
          // Telegram no longer holds them, and delivers to the computer again.
          expect(yield* waitFor(() => held.length === 0 && webhookIsOurs(), real(MINUTE))).toBe(
            true,
          );
          // The old failure is not a reason to keep fetching: the webhook stays.
          const deletes = count("deleteWebhook");
          yield* Effect.sleep("5 minutes");
          expect(count("deleteWebhook")).toBe(deletes);
          expect(webhookIsOurs()).toBe(true);
          expect(world.turnCount).toBe(2);
        }),
      );
    }),
  60_000,
);

it.live(
  "economy switched off: back to long polling, nothing answered twice; switched on again: the webhook returns",
  () =>
    Effect.gen(function* () {
      yield* daemonRun(
        nodePath.join(tmpDir, "state.sqlite"),
        Effect.gen(function* () {
          yield* connect;
          expect(yield* waitFor(webhookIsOurs, real(2 * MINUTE))).toBe(true);
          const viaWebhook = say("через webhook");
          expect(yield* deliver(viaWebhook)).toBe("accepted");
          expect(yield* waitFor(() => answers().length === 1, real(10 * MINUTE))).toBe(true);
          // Telegram may still offer an update it delivered (our 200 got lost).
          held.push(viaWebhook);

          box = { id: BOX_ID, url: ADDRESS, wake_on_http: true, economy: { enabled: false } };
          expect(yield* waitFor(() => webhook === null, real(4 * MINUTE))).toBe(true);
          const viaPolling = say("через polling");
          expect(yield* waitFor(() => answers().length === 2, real(10 * MINUTE))).toBe(true);
          expect(answers().map((entry) => [entry.text, entry.replyTo])).toEqual([
            ["ответ: через webhook", viaWebhook.message.message_id],
            ["ответ: через polling", viaPolling.message.message_id],
          ]);
          expect(world.turnCount).toBe(2);

          box = { id: BOX_ID, url: ADDRESS, wake_on_http: true, economy: { enabled: true } };
          expect(yield* waitFor(webhookIsOurs, real(4 * MINUTE))).toBe(true);
        }),
      );
    }),
  60_000,
);

it.live(
  "the console is down: the webhook is neither set on a guess nor taken away",
  () =>
    Effect.gen(function* () {
      const dbPath = nodePath.join(tmpDir, "state.sqlite");
      // Never answered: stay on long polling.
      box = null;
      yield* daemonRun(
        dbPath,
        Effect.gen(function* () {
          yield* connect;
          const asked = say("консоль лежит");
          expect(yield* waitFor(() => answers().length === 1, real(10 * MINUTE))).toBe(true);
          expect(answers()[0]?.replyTo).toBe(asked.message.message_id);
          expect(count("setWebhook")).toBe(0);

          // The console is back: the webhook appears.
          box = { id: BOX_ID, url: ADDRESS, wake_on_http: true, economy: { enabled: true } };
          expect(yield* waitFor(webhookIsOurs, real(2 * MINUTE))).toBe(true);
        }),
      );
      // The daemon restarts while the console is down: our webhook stays (it
      // delivers here anyway) and a delivered message is answered.
      box = null;
      yield* daemonRun(
        dbPath,
        Effect.gen(function* () {
          yield* Effect.sleep("3 minutes");
          expect(webhookIsOurs()).toBe(true);
          expect(count("deleteWebhook")).toBe(0);
          const asked = say("после рестарта");
          expect(yield* deliver(asked)).toBe("accepted");
          expect(yield* waitFor(() => answers().length === 2, real(10 * MINUTE))).toBe(true);
          expect(answers()[1]?.replyTo).toBe(asked.message.message_id);
        }),
      );
    }),
  60_000,
);

it.live(
  "a message stored just before the daemon stopped is answered after the restart, once",
  () =>
    Effect.gen(function* () {
      const dbPath = nodePath.join(tmpDir, "state.sqlite");
      const asked = yield* daemonRun(
        dbPath,
        Effect.gen(function* () {
          yield* connect;
          expect(yield* waitFor(webhookIsOurs, real(2 * MINUTE))).toBe(true);
          const update = say("успей сохранить");
          // Telegram was told 200 — from here on the daemon alone has it.
          expect(yield* deliver(update)).toBe("accepted");
          return update;
        }),
      );
      world.restart();
      yield* daemonRun(
        dbPath,
        Effect.gen(function* () {
          expect(yield* waitFor(() => answers().length > 0, real(10 * MINUTE))).toBe(true);
          yield* Effect.sleep("3 minutes");
          expect(answers().map((entry) => entry.replyTo)).toEqual([asked.message.message_id]);
        }),
      );
    }),
  60_000,
);

it.live(
  "a bot whose webhook belongs to another service is left alone and says why",
  () =>
    Effect.gen(function* () {
      webhook = { url: "https://my-own-service.example/telegram", secret: "theirs" };
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
          expect(status.lastError).toMatch(/another service/);
          expect(status.health?.status).toBe("provider_unavailable");
        }),
      );
      expect(webhook).toEqual({ url: "https://my-own-service.example/telegram", secret: "theirs" });
      expect(count("setWebhook")).toBe(0);
      expect(count("deleteWebhook")).toBe(0);
    }),
  60_000,
);

it.live(
  "the bot is switched off: Telegram stops delivering here (and waking the computer)",
  () =>
    Effect.gen(function* () {
      yield* daemonRun(
        nodePath.join(tmpDir, "state.sqlite"),
        Effect.gen(function* () {
          yield* connect;
          expect(yield* waitFor(webhookIsOurs, real(2 * MINUTE))).toBe(true);
          yield* saveBot(false);
          expect(yield* waitFor(() => webhook === null, real(2 * MINUTE))).toBe(true);
          // And a late delivery for the switched-off bot is not taken.
          const telegram = yield* ManagerTelegramService;
          expect(
            yield* telegram.receiveWebhookUpdate({
              hookId: telegramWebhookHookId(BOT),
              secret: telegramWebhookSecret(BOT),
              readUpdate: Effect.succeed(newUpdate("поздно")),
            }),
          ).toBe("unknown");
        }),
      );
    }),
  60_000,
);
