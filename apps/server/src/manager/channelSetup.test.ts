import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, expect, it, vi } from "@effect/vitest";
import {
  ASSISTANT_PROJECT_ID,
  DEFAULT_CONNECTOR_ADDRESSING,
  ManagerSlackConnectorConfig,
  ManagerTelegramConnectorConfig,
  ManagerTelegramConnectorStatus,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Schema, Stream } from "effect";

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
import { telegramConnectorStatus } from "./Layers/AssistantService.ts";
import { ManagerSlackService } from "./Layers/SlackConnector.ts";
import { ManagerTelegramService, ManagerTelegramServiceLive } from "./Layers/TelegramConnector.ts";
import {
  afterTelegramConfigSaved,
  connectSharedTelegram,
  readSlackInstall,
  startSlackInstall,
  uninstallSlack,
} from "./channelSetup.ts";
import { readWorkMachineIdentity, type WorkMachineIdentity } from "./workConsole.ts";

const CONSOLE = "http://console.test";
const BOX_TOKEN = "uno_agt_machine";
const identity: WorkMachineIdentity = { boxToken: BOX_TOKEN, boxId: 4242 };
const TGR = "tgr_" + "a".repeat(64);
const SLR = "slr_" + "b".repeat(64);
const projectId = ASSISTANT_PROJECT_ID;

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

type Route = (request: Recorded) => Response | Promise<Response> | undefined;

/**
 * Global `fetch` stub: records every request and answers from `routes`
 * (first match wins). Bot-API long polls of the live connector get an empty,
 * slightly delayed answer so the poller never spins.
 */
const installFetch = (routes: ReadonlyArray<Route>) => {
  const calls: Array<Recorded> = [];
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const request = {
      method: init?.method ?? "GET",
      url,
      authorization: headers.get("authorization"),
      body,
    };
    calls.push(request);
    for (const route of routes) {
      const response = await route(request);
      if (response !== undefined) return response;
    }
    if (url.includes("/getUpdates") || url.includes("/getMe")) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return Response.json({
        ok: true,
        result: url.includes("/getMe") ? { username: "get_uno_bot" } : [],
      });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchStub);
  return calls;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });
const route =
  (method: string, pathSuffix: string, answer: () => Response): Route =>
  (request) =>
    request.method === method && new URL(request.url).pathname.endsWith(pathSuffix)
      ? answer()
      : undefined;

beforeEach(() => {
  vi.stubEnv(CONTROL_PLANE_URL_OVERRIDE_ENV, CONSOLE);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const repositories = Layer.mergeAll(
  ManagerConnectorRepositoryLive,
  ManagerConnectorBindingRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

/** The real Telegram connector over an in-memory DB; orchestration is never reached. */
const telegramLayer = ManagerTelegramServiceLive.pipe(
  Layer.provideMerge(repositories),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(OrchestrationEngineService)({
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
      }),
      Layer.mock(ProjectionSnapshotQuery)({}),
      Layer.mock(ProjectionPendingApprovalRepository)({
        listByThreadId: () => Effect.succeed([]),
      }),
      ServerSettingsService.layerTest({}),
      ServerConfig.layerTest(process.cwd(), { prefix: "uno-channel-setup-test-" }),
    ),
  ),
);

const slackLayer = (connected: boolean) =>
  repositories.pipe(
    Layer.provideMerge(
      Layer.mock(ManagerSlackService)({
        getRuntimeStatus: () =>
          Effect.succeed({
            botUserId: connected ? "UBOT" : null,
            botUserName: connected ? "uno" : null,
            lastError: null,
            connected,
          }),
      }),
    ),
  );

const readTelegramRow = Effect.gen(function* () {
  const repository = yield* ManagerConnectorRepository;
  const row = yield* repository.get({ projectId, kind: "telegram" });
  return Option.isSome(row)
    ? Schema.decodeUnknownSync(ManagerTelegramConnectorConfig)(row.value.config)
    : null;
});

const readSlackRow = Effect.gen(function* () {
  const repository = yield* ManagerConnectorRepository;
  const row = yield* repository.get({ projectId, kind: "slack" });
  return Option.isSome(row)
    ? Schema.decodeUnknownSync(ManagerSlackConnectorConfig)(row.value.config)
    : null;
});

const saveTelegramRow = (config: ManagerTelegramConnectorConfig) =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    yield* repository.upsert({
      projectId,
      kind: "telegram",
      config,
      updatedAt: new Date().toISOString(),
    });
  });

it("reads the machine identity only from a machine token plus a box id", () => {
  expect(readWorkMachineIdentity({ boxToken: " uno_agt_x ", boxId: 7 })).toEqual({
    boxToken: "uno_agt_x",
    boxId: 7,
  });
  expect(readWorkMachineIdentity({ boxToken: "", boxId: 7 })).toBeNull();
  expect(readWorkMachineIdentity({ boxToken: "uno_agt_x", boxId: null })).toBeNull();
  expect(readWorkMachineIdentity(undefined)).toBeNull();
});

it("never exposes the bot token in the connector status, own or shared", () => {
  const runtime = { botUsername: "get_uno_bot", lastError: null, health: null };
  const shared = telegramConnectorStatus(
    { botToken: `unorelay:${TGR}`, allowedChatIds: ["1"], enabled: true },
    runtime,
  );
  const own = telegramConnectorStatus(
    { botToken: "123:own-secret", allowedChatIds: [], enabled: true },
    runtime,
  );
  expect(shared.shared).toBe(true);
  expect(own.shared).toBe(false);
  for (const status of [shared, own]) {
    const encoded = JSON.stringify(Schema.encodeSync(ManagerTelegramConnectorStatus)(status));
    expect(encoded).not.toContain(TGR);
    expect(encoded).not.toContain("own-secret");
    expect(encoded).not.toContain("unorelay");
  }
  expect(shared.addressing).toEqual(DEFAULT_CONNECTOR_ADDRESSING);
});

it.layer(NodeServices.layer)("Telegram via Uno's shared bot", (it) => {
  it.effect("answers 409 not_cloud_computer without a machine token", () =>
    Effect.gen(function* () {
      const calls = installFetch([]);
      const outcome = yield* connectSharedTelegram({ projectId, identity: null });
      expect(outcome).toMatchObject({
        ok: false,
        failure: { status: 409, error: "not_cloud_computer" },
      });
      expect(calls.filter((call) => call.url.startsWith(CONSOLE))).toEqual([]);
    }).pipe(Effect.provide(telegramLayer)),
  );

  it.effect(
    "mints the relay, keeps the settings, stores the relay token and registers the link code",
    () =>
      Effect.gen(function* () {
        yield* saveTelegramRow({
          botToken: "123:own",
          allowedChatIds: ["555"],
          enabled: false,
          defaultModelSelection: null,
          addressing: { ...DEFAULT_CONNECTOR_ADDRESSING, names: ["Uno"] },
        });
        const calls = installFetch([
          route("POST", "/api/v1/boxes/4242/work/telegram/relay", () =>
            json({ relay_token: TGR, bot_username: "get_uno_bot", api_base: "x" }),
          ),
          route("POST", `/bot${TGR}/unoRegisterStartCode`, () => json({ ok: true, result: true })),
        ]);

        const outcome = yield* connectSharedTelegram({ projectId, identity });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.value.botUsername).toBe("get_uno_bot");
        expect(outcome.value.link).toBe(`https://t.me/get_uno_bot?start=${outcome.value.code}`);
        expect(Date.parse(outcome.value.expiresAt)).toBeGreaterThan(Date.now());

        const mint = calls.find((call) => call.url.endsWith("/work/telegram/relay"));
        expect(mint?.authorization).toBe(`Bearer ${BOX_TOKEN}`);
        const register = calls.find((call) => call.url.endsWith("/unoRegisterStartCode"));
        expect(register?.url).toBe(
          `${CONSOLE}/api/v1/work-relay/telegram/bot${TGR}/unoRegisterStartCode`,
        );
        expect(register?.body).toEqual({ code: outcome.value.code, expires_in: 900 });

        const row = yield* readTelegramRow;
        expect(row).toMatchObject({
          botToken: `unorelay:${TGR}`,
          enabled: true,
          allowedChatIds: ["555"],
          addressing: { names: ["Uno"] },
        });
      }).pipe(Effect.provide(telegramLayer)),
  );

  it.effect("maps an unconfigured shared bot to 503 shared_bot_unavailable", () =>
    Effect.gen(function* () {
      installFetch([
        route("POST", "/work/telegram/relay", () =>
          json({ code: "TELEGRAM_SHARED_BOT_NOT_CONFIGURED" }, 503),
        ),
      ]);
      const outcome = yield* connectSharedTelegram({ projectId, identity });
      expect(outcome).toMatchObject({
        ok: false,
        failure: { status: 503, error: "shared_bot_unavailable" },
      });
      expect(yield* readTelegramRow).toBeNull();
    }).pipe(Effect.provide(telegramLayer)),
  );

  it.effect("maps an unreachable console to 502 console_unreachable", () =>
    Effect.gen(function* () {
      installFetch([
        (request) => {
          if (request.url.startsWith(CONSOLE)) throw new TypeError("fetch failed");
          return undefined;
        },
      ]);
      const outcome = yield* connectSharedTelegram({ projectId, identity });
      expect(outcome).toMatchObject({
        ok: false,
        failure: { status: 502, error: "console_unreachable" },
      });
    }).pipe(Effect.provide(telegramLayer)),
  );

  it.effect("fails with 502 when the console refuses the link code", () =>
    Effect.gen(function* () {
      installFetch([
        route("POST", "/work/telegram/relay", () =>
          json({ relay_token: TGR, bot_username: "get_uno_bot" }),
        ),
        route("POST", "/unoRegisterStartCode", () =>
          json({ ok: false, error_code: 400, description: "Bad Request: code" }, 400),
        ),
      ]);
      const outcome = yield* connectSharedTelegram({ projectId, identity });
      expect(outcome).toMatchObject({
        ok: false,
        failure: { status: 502, error: "console_error" },
      });
    }).pipe(Effect.provide(telegramLayer)),
  );

  it.effect("does not register codes for an own bot", () =>
    Effect.gen(function* () {
      yield* saveTelegramRow({ botToken: "123:own", allowedChatIds: [], enabled: false });
      const calls = installFetch([]);
      const telegram = yield* ManagerTelegramService;
      const pairing = yield* telegram.startPairing(projectId);
      expect(pairing.code).toMatch(/^uno[0-9a-f]{12}$/);
      expect(calls.some((call) => call.url.includes("unoRegisterStartCode"))).toBe(false);
    }).pipe(Effect.provide(telegramLayer)),
  );

  it.effect("unlinks chats removed from a shared-bot connector at the console", () =>
    Effect.gen(function* () {
      const calls = installFetch([
        route("POST", "/unoUnlinkChat", () => json({ ok: true, result: true })),
      ]);
      const relay = `unorelay:${TGR}`;
      yield* afterTelegramConfigSaved({
        previous: { botToken: relay, allowedChatIds: ["1", "2", "3"], enabled: true },
        next: { botToken: relay, allowedChatIds: ["2"], enabled: true },
        identity,
      });
      const unlinked = calls.filter((call) => call.url.endsWith("/unoUnlinkChat"));
      expect(unlinked.map((call) => call.body)).toEqual([{ chat_id: "1" }, { chat_id: "3" }]);
      expect(unlinked[0]?.url).toBe(
        `${CONSOLE}/api/v1/work-relay/telegram/bot${TGR}/unoUnlinkChat`,
      );
    }),
  );

  it.effect("deletes the relay when the owner switches back to an own bot", () =>
    Effect.gen(function* () {
      const calls = installFetch([
        route(
          "DELETE",
          "/api/v1/boxes/4242/work/telegram/relay",
          () => new Response(null, { status: 204 }),
        ),
      ]);
      yield* afterTelegramConfigSaved({
        previous: { botToken: `unorelay:${TGR}`, allowedChatIds: ["1"], enabled: true },
        next: { botToken: "123:own", allowedChatIds: ["1"], enabled: true },
        identity,
      });
      expect(
        calls.filter((call) => call.method === "DELETE").map((call) => call.authorization),
      ).toEqual([`Bearer ${BOX_TOKEN}`]);
      expect(calls.some((call) => call.url.includes("unoUnlinkChat"))).toBe(false);
    }),
  );

  it.effect("leaves own-bot saves alone", () =>
    Effect.gen(function* () {
      const calls = installFetch([]);
      yield* afterTelegramConfigSaved({
        previous: { botToken: "123:own", allowedChatIds: ["1", "2"], enabled: true },
        next: { botToken: "123:own", allowedChatIds: [], enabled: true },
        identity,
      });
      expect(calls).toEqual([]);
    }),
  );
});

it.layer(NodeServices.layer)("Slack via Uno's app", (it) => {
  it.effect("returns the authorize URL, or available:false when the console has no app", () =>
    Effect.gen(function* () {
      installFetch([
        route("POST", "/api/v1/boxes/4242/work/slack/install", () =>
          json({ available: true, authorize_url: "https://slack.com/oauth/v2/authorize?x=1" }),
        ),
      ]);
      expect(yield* startSlackInstall({ identity })).toEqual({
        ok: true,
        value: { available: true, authorizeUrl: "https://slack.com/oauth/v2/authorize?x=1" },
      });

      installFetch([
        route("POST", "/work/slack/install", () =>
          json({ available: false, code: "SLACK_APP_NOT_CONFIGURED" }, 503),
        ),
      ]);
      expect(yield* startSlackInstall({ identity })).toEqual({
        ok: true,
        value: { available: false, authorizeUrl: null },
      });

      expect(yield* startSlackInstall({ identity: null })).toMatchObject({
        ok: false,
        failure: { status: 409, error: "not_cloud_computer" },
      });
    }),
  );

  it.effect("switches the connector to the relay once installed, and only once", () =>
    Effect.gen(function* () {
      const repository = yield* ManagerConnectorRepository;
      yield* repository.upsert({
        projectId,
        kind: "slack",
        config: {
          botToken: "xoxb-own",
          appToken: "xapp-own",
          allowedChannelIds: ["D123"],
          enabled: false,
          defaultModelSelection: null,
        },
        updatedAt: new Date().toISOString(),
      });
      const calls = installFetch([
        route("GET", "/api/v1/boxes/4242/work/slack", () =>
          json({
            available: true,
            installed: true,
            team_id: "T1",
            team_name: "Acme",
            bot_user_id: "UBOT",
            bot_user_name: "uno",
          }),
        ),
        route("POST", "/api/v1/boxes/4242/work/slack/relay", () =>
          json({ relay_token: SLR, api_base: `${CONSOLE}/api/v1/work-relay/slack/${SLR}/api/` }),
        ),
      ]);

      const first = yield* readSlackInstall({ projectId, identity });
      expect(first).toEqual({
        ok: true,
        value: {
          available: true,
          installed: true,
          teamName: "Acme",
          botUserName: "uno",
          connected: true,
          installerDmReady: false,
        },
      });
      expect(yield* readSlackRow).toMatchObject({
        botToken: `unorelay:${SLR}`,
        appToken: "unorelay",
        enabled: true,
        allowedChannelIds: ["D123"],
      });

      yield* readSlackInstall({ projectId, identity });
      expect(calls.filter((call) => call.url.endsWith("/work/slack/relay"))).toHaveLength(1);
    }).pipe(Effect.provide(slackLayer(true))),
  );

  it.effect("does not touch the connector while the app is not installed", () =>
    Effect.gen(function* () {
      const calls = installFetch([
        route("GET", "/work/slack", () => json({ available: true, installed: false })),
      ]);
      expect(yield* readSlackInstall({ projectId, identity })).toEqual({
        ok: true,
        value: {
          available: true,
          installed: false,
          teamName: null,
          botUserName: null,
          connected: false,
          installerDmReady: false,
        },
      });
      expect(calls.some((call) => call.url.endsWith("/work/slack/relay"))).toBe(false);
      expect(yield* readSlackRow).toBeNull();
    }).pipe(Effect.provide(slackLayer(false))),
  );

  it.effect("uninstalls at the console and forgets a relay-mode row only", () =>
    Effect.gen(function* () {
      const repository = yield* ManagerConnectorRepository;
      yield* repository.upsert({
        projectId,
        kind: "slack",
        config: {
          botToken: `unorelay:${SLR}`,
          appToken: "unorelay",
          allowedChannelIds: [],
          enabled: true,
        },
        updatedAt: new Date().toISOString(),
      });
      const calls = installFetch([
        route("DELETE", "/api/v1/boxes/4242/work/slack", () => new Response(null, { status: 204 })),
      ]);
      expect(yield* uninstallSlack({ projectId, identity })).toEqual({
        ok: true,
        value: { ok: true },
      });
      expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
      expect(yield* readSlackRow).toBeNull();

      yield* repository.upsert({
        projectId,
        kind: "slack",
        config: {
          botToken: "xoxb-own",
          appToken: "xapp-own",
          allowedChannelIds: [],
          enabled: true,
        },
        updatedAt: new Date().toISOString(),
      });
      yield* uninstallSlack({ projectId, identity });
      expect((yield* readSlackRow)?.botToken).toBe("xoxb-own");
    }).pipe(Effect.provide(slackLayer(false))),
  );

  it.effect("opens and allowlists the installer's DM through the relay, keeping other ids", () =>
    Effect.gen(function* () {
      const repository = yield* ManagerConnectorRepository;
      yield* repository.upsert({
        projectId,
        kind: "slack",
        config: {
          botToken: `unorelay:${SLR}`,
          appToken: "unorelay",
          allowedChannelIds: ["C_EXISTING"],
          enabled: true,
        },
        updatedAt: new Date().toISOString(),
      });
      const calls = installFetch([
        route("GET", "/api/v1/boxes/4242/work/slack", () =>
          json({ available: true, installed: true, team_name: "Acme", installer_user_id: "UINST" }),
        ),
        route("POST", `/api/v1/work-relay/slack/${SLR}/api/conversations.open`, () =>
          json({ ok: true, channel: { id: "DINST" } }),
        ),
      ]);

      const first = yield* readSlackInstall({ projectId, identity });
      expect(first).toMatchObject({ ok: true, value: { installerDmReady: true } });
      expect((yield* readSlackRow)?.allowedChannelIds).toEqual(["C_EXISTING", "DINST"]);
      const open = calls.find((call) => call.url.endsWith("/conversations.open"));
      expect(open?.body).toBe("users=UINST");
      expect(open?.authorization).toBeNull();

      // Later checks re-open (idempotent at Slack) without duplicating the id.
      yield* readSlackInstall({ projectId, identity });
      expect((yield* readSlackRow)?.allowedChannelIds).toEqual(["C_EXISTING", "DINST"]);
    }).pipe(Effect.provide(slackLayer(true))),
  );

  it.effect("reports installerDmReady false when the DM cannot be opened", () =>
    Effect.gen(function* () {
      const repository = yield* ManagerConnectorRepository;
      yield* repository.upsert({
        projectId,
        kind: "slack",
        config: {
          botToken: `unorelay:${SLR}`,
          appToken: "unorelay",
          allowedChannelIds: [],
          enabled: true,
        },
        updatedAt: new Date().toISOString(),
      });
      installFetch([
        route("GET", "/work/slack", () =>
          json({ available: true, installed: true, installer_user_id: "UINST" }),
        ),
        route("POST", "/conversations.open", () => json({ ok: false, error: "missing_scope" })),
      ]);
      expect(yield* readSlackInstall({ projectId, identity })).toMatchObject({
        ok: true,
        value: { installerDmReady: false },
      });
      expect((yield* readSlackRow)?.allowedChannelIds).toEqual([]);
    }).pipe(Effect.provide(slackLayer(false))),
  );

  it.effect("reports console failures as 502", () =>
    Effect.gen(function* () {
      installFetch([route("GET", "/work/slack", () => json({ error: "boom" }, 500))]);
      expect(yield* readSlackInstall({ projectId, identity })).toMatchObject({
        ok: false,
        failure: { status: 502, error: "console_error" },
      });
    }).pipe(Effect.provide(slackLayer(false))),
  );
});
