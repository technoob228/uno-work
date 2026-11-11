/**
 * The assistant's own bot through the console relay (11.11), through the real
 * Telegram connector against a fake Bot API and console (global `fetch` stub —
 * nothing leaves the test). A cloud computer (box token in settings):
 *
 * - answers on api.telegram.org first, confirms what it handled, then hands
 *   the bot to the console and reads the console's queue from its start;
 * - stays on api.telegram.org when the console does not take own bots (flag
 *   off) and does not ask again every cycle;
 * - goes back to api.telegram.org when the console forgets the relay (401);
 * - takes a webhook left from before a restart back through the console, or —
 *   with the rollout off — asks the console to drop it and reads directly;
 * - releases a bot the console still routes here that no assistant uses.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, expect, it, vi } from "@effect/vitest";
import { ASSISTANT_PROJECT_ID, type OrchestrationCommand } from "@t3tools/contracts";
import { Effect, Layer, Option, Stream } from "effect";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorBindingRepositoryLive } from "../persistence/Layers/ManagerConnectorBindings.ts";
import { ManagerConnectorRepositoryLive } from "../persistence/Layers/ManagerConnectors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import { ProjectionPendingApprovalRepository } from "../persistence/Services/ProjectionPendingApprovals.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CONTROL_PLANE_URL_OVERRIDE_ENV } from "../workspaceRegistry/unoCloudParse.ts";
import { ownBotRelay, ownBotRelayTokens, setOwnBotRelay } from "./channelRelay.ts";
import { ManagerTelegramService, ManagerTelegramServiceLive } from "./Layers/TelegramConnector.ts";
import { resetOwnBotRelayState } from "./ownBotRelay.ts";

const CONSOLE = "http://console.test";
const BOX = 3268;
const OWN = "123456:own-bot-token-for-tests-only";
const TGO = "tgo_" + "d".repeat(64);
const CHAT = 777;
const projectId = ASSISTANT_PROJECT_ID;
const WEBHOOK_CONFLICT =
  "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first";

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

let calls: Array<Recorded> = [];
/** Telegram's own queue of the bot (what a direct getUpdates sees). */
let direct: Array<Record<string, unknown>> = [];
/** The console relay's queue (what the mirror's getUpdates sees). */
let relayQueue: Array<Record<string, unknown>> = [];
/** Whether the bot's webhook is set (a direct getUpdates then gets 409). */
let webhookSet = false;
/** What the console answers to a registration. */
let consoleMode: "on" | "off" = "on";
/** The console forgot the relay: the mirror answers 401. */
let relayGone = false;
/** Bots the console says it routes to this box (`GET ?bot=own`). */
let heldBots: Array<number> = [];

const json = (body: unknown, status = 200) => Response.json(body, { status });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const installFetch = () => {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      let body: unknown = null;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      const method = init?.method ?? "GET";
      calls.push({ method, url, body });
      const parsed = new URL(url);
      const path = parsed.pathname;

      if (path === `/api/v1/boxes/${BOX}/work/telegram/relay`) {
        if (method === "POST") {
          if (consoleMode === "off") {
            return json({ code: "OWN_BOT_RELAY_OFF", error: "own bots are not routed" }, 503);
          }
          webhookSet = true;
          relayGone = false;
          heldBots = [123456];
          return json({
            relay_token: TGO,
            bot: "own",
            bot_username: "my_assistant_bot",
            bot_id: 123456,
            api_base: `${CONSOLE}/api/v1/work-relay/telegram`,
          });
        }
        if (method === "DELETE") {
          const botId = Number(parsed.searchParams.get("bot_id"));
          if (heldBots.includes(botId)) {
            heldBots = heldBots.filter((id) => id !== botId);
            if (botId === 123456) webhookSet = false;
          }
          return new Response(null, { status: 204 });
        }
        return json({
          exists: heldBots.length > 0,
          bots: heldBots.map((id) => ({ bot_id: id, bot_username: `bot${id}` })),
        });
      }

      const viaRelay = path.startsWith(`/api/v1/work-relay/telegram/bot${TGO}/`);
      const viaDirect = parsed.host === "api.telegram.org" && path.startsWith(`/bot${OWN}/`);
      if (!viaRelay && !viaDirect) return new Response("not found", { status: 404 });
      if (viaRelay && relayGone) {
        return json({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
      }
      if (path.endsWith("/getMe")) {
        return json({ ok: true, result: { id: 123456, username: "my_assistant_bot" } });
      }
      if (path.endsWith("/getUpdates")) {
        if (viaDirect && webhookSet) {
          return json({ ok: false, error_code: 409, description: WEBHOOK_CONFLICT }, 409);
        }
        const queue = viaRelay ? relayQueue : direct;
        const offset = Number(parsed.searchParams.get("offset") ?? "0");
        // Telegram semantics: everything below the offset is confirmed.
        while (queue.length > 0 && Number(queue[0]!.update_id) < offset) queue.shift();
        const limit = Number(parsed.searchParams.get("limit") ?? "100");
        if (queue.length > 0) return json({ ok: true, result: queue.slice(0, limit) });
        if (parsed.searchParams.get("timeout") !== "0") await pause(100);
        return json({ ok: true, result: [] });
      }
      if (/\/(sendMessage|sendChatAction|setMessageReaction)$/.test(path)) {
        return json({ ok: true, result: { message_id: 1 } });
      }
      return new Response("not found", { status: 404 });
    }),
  );
};

beforeEach(() => {
  vi.stubEnv(CONTROL_PLANE_URL_OVERRIDE_ENV, CONSOLE);
  direct = [];
  relayQueue = [];
  webhookSet = false;
  consoleMode = "on";
  relayGone = false;
  heldBots = [];
  dispatched.length = 0;
  for (const token of ownBotRelayTokens()) setOwnBotRelay(token, null);
  resetOwnBotRelayState();
  installFetch();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const dispatched: Array<OrchestrationCommand> = [];
const repositories = Layer.mergeAll(
  ManagerConnectorRepositoryLive,
  ManagerConnectorBindingRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const connectorLayer = ManagerTelegramServiceLive.pipe(
  Layer.provideMerge(repositories),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(OrchestrationEngineService)({
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [],
            threads: [],
            updatedAt: "2026-11-11T00:00:00.000Z",
          }),
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
        getProjectShellById: (id) =>
          Effect.succeed(
            Option.some({
              id,
              title: "Uno",
              workspaceRoot: "/tmp/Uno",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-11-11T00:00:00.000Z",
              updatedAt: "2026-11-11T00:00:00.000Z",
            }),
          ),
      }),
      Layer.mock(ProjectionPendingApprovalRepository)({
        listByThreadId: () => Effect.succeed([]),
      }),
      // A cloud computer: the console knows it by its box token.
      ServerSettingsService.layerTest({
        uno: { apiKey: "sk-uno-test", boxToken: "uno_agt_test", boxId: BOX },
      } as never),
      ServerConfig.layerTest(process.cwd(), { prefix: "uno-tg-own-bot-relay-test-" }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const saveRow = (botToken: string) =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    yield* repository.upsert({
      projectId,
      kind: "telegram",
      config: {
        botToken,
        allowedChatIds: [String(CHAT)],
        ownerUserIds: [String(CHAT)],
        enabled: true,
        defaultModelSelection: null,
      },
      updatedAt: new Date().toISOString(),
    });
  });

const textUpdate = (updateId: number, text: string) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1_762_800_000,
    text,
    chat: { id: CHAT, type: "private" },
    from: { id: CHAT, is_bot: false, language_code: "en" },
  },
});

const waitUntil = (check: () => boolean, attempts = 100) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (check()) return true;
      yield* Effect.sleep("100 millis");
    }
    return check();
  });

const turnTexts = () =>
  dispatched.flatMap((command) =>
    command.type === "thread.turn.start" ? [command.message.text] : [],
  );
const turnsWith = (text: string) => turnTexts().filter((turn) => turn.includes(text)).length;

const registrations = () =>
  calls.filter((call) => call.method === "POST" && call.url.endsWith("/work/telegram/relay"));
const releases = () => calls.filter((call) => call.method === "DELETE");
const relayPolls = () =>
  calls.filter((call) => call.url.includes(`/work-relay/telegram/bot${TGO}/getUpdates`));

it.live(
  "answers on api.telegram.org, confirms what it handled, then reads Uno's queue from the start",
  () =>
    Effect.gen(function* () {
      direct.push(textUpdate(41, "first, before the switch"));
      yield* saveRow(OWN);
      expect(yield* waitUntil(() => registrations().length > 0)).toBe(true);
      expect(turnsWith("first, before the switch")).toBe(1);

      // The confirm call acked update 41 before the console took the webhook.
      const registerAt = calls.indexOf(registrations()[0]!);
      const confirm = calls
        .slice(0, registerAt)
        .findLast((call) => call.url.includes(`/bot${OWN}/getUpdates`));
      expect(confirm?.url).toContain("timeout=0");
      expect(confirm?.url).toContain("offset=42");
      expect(registrations()[0]!.body).toEqual({
        bot: "own",
        token: OWN,
        allowed_updates: ["message", "callback_query", "poll_answer", "widget_query"],
      });
      expect(ownBotRelay(OWN)).toBe(TGO);

      // From now on: the console's queue, from its own first id.
      expect(yield* waitUntil(() => relayPolls().length > 0)).toBe(true);
      expect(relayPolls()[0]!.url).toContain("offset=0");
      relayQueue.push(textUpdate(7, "second, through Uno"));
      expect(yield* waitUntil(() => turnsWith("second, through Uno") === 1)).toBe(true);
      // What the assistant sends goes out through the console too.
      const telegram = yield* ManagerTelegramService;
      expect(
        yield* telegram.sendText({ projectId, chatId: String(CHAT), text: "a reminder" }),
      ).toBe(true);
      expect(calls.some((call) => call.url.endsWith(`bot${TGO}/sendMessage`))).toBe(true);
      yield* Effect.sleep("500 millis");
      expect(turnsWith("first, before the switch")).toBe(1);
      expect(
        calls.filter(
          (call, index) =>
            index > calls.indexOf(registrations()[0]!) &&
            call.url.startsWith(`https://api.telegram.org/bot${OWN}/`),
        ),
      ).toEqual([]);
    }).pipe(Effect.provide(connectorLayer)),
);

it.live("rollout off: stays on api.telegram.org and does not ask again every cycle", () =>
  Effect.gen(function* () {
    consoleMode = "off";
    yield* saveRow(OWN);
    expect(yield* waitUntil(() => registrations().length > 0)).toBe(true);
    direct.push(textUpdate(10, "still direct"));
    expect(yield* waitUntil(() => turnsWith("still direct") === 1)).toBe(true);
    yield* Effect.sleep("1500 millis");
    expect(registrations()).toHaveLength(1);
    expect(ownBotRelay(OWN)).toBeNull();
    expect(releases()).toEqual([]);
  }).pipe(Effect.provide(connectorLayer)),
);

it.live("the console forgot the relay (401): back to api.telegram.org", () =>
  Effect.gen(function* () {
    yield* saveRow(OWN);
    expect(yield* waitUntil(() => relayPolls().length > 0)).toBe(true);
    // Dropped at the console (the webhook with it).
    relayGone = true;
    webhookSet = false;
    expect(yield* waitUntil(() => ownBotRelay(OWN) === null)).toBe(true);
    direct.push(textUpdate(90, "after the relay is gone"));
    expect(yield* waitUntil(() => turnsWith("after the relay is gone") === 1)).toBe(true);
    // Not taken back at once: the next attempt waits 10 minutes.
    expect(registrations()).toHaveLength(1);
  }).pipe(Effect.provide(connectorLayer)),
);

it.live("a webhook left from before a restart: the bot goes back through Uno", () =>
  Effect.gen(function* () {
    webhookSet = true;
    heldBots = [123456];
    yield* saveRow(OWN);
    expect(yield* waitUntil(() => ownBotRelay(OWN) === TGO)).toBe(true);
    relayQueue.push(textUpdate(3, "queued while it slept"));
    expect(yield* waitUntil(() => turnsWith("queued while it slept") === 1)).toBe(true);
    // Its own bot is in use here: not released by the start-up cleanup.
    expect(releases()).toEqual([]);
  }).pipe(Effect.provide(connectorLayer)),
);

it.live("a webhook left behind with the rollout off: Uno drops it, Telegram directly", () =>
  Effect.gen(function* () {
    webhookSet = true;
    heldBots = [123456];
    consoleMode = "off";
    yield* saveRow(OWN);
    expect(yield* waitUntil(() => releases().length > 0)).toBe(true);
    expect(releases()[0]!.url).toContain("bot=own&bot_id=123456");
    direct.push(textUpdate(5, "direct again"));
    expect(yield* waitUntil(() => turnsWith("direct again") === 1)).toBe(true);
  }).pipe(Effect.provide(connectorLayer)),
);

it.live("a bot the console routes here that no assistant uses is released after a start", () =>
  Effect.gen(function* () {
    heldBots = [999];
    yield* saveRow(OWN);
    expect(yield* waitUntil(() => releases().some((call) => call.url.includes("bot_id=999")))).toBe(
      true,
    );
    expect(releases().some((call) => call.url.includes("bot_id=123456"))).toBe(false);
  }).pipe(Effect.provide(connectorLayer)),
);
