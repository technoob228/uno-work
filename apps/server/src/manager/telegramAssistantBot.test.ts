/**
 * Uno's assistant bot (@uno_work_bot, `tga_` relay) and media on any bot,
 * through the real Telegram connector against a fake Bot API / console /
 * gateway (global `fetch` stub — nothing leaves the test):
 *
 * - a `/start <code>` the console already answered (`uno_linked: true`) links
 *   the chat without the daemon's own hello; on an own bot the flag means
 *   nothing;
 * - media over the limits is refused in the chat before any download, and
 *   the turn runs only if something else is left;
 * - a video is described through the gateway; an older gateway falls back to
 *   the audio track plus Telegram's preview frame.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, expect, it, vi } from "@effect/vitest";
import {
  ASSISTANT_PROJECT_ID,
  ManagerTelegramConnectorConfig,
  type OrchestrationCommand,
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
import { ManagerTelegramService, ManagerTelegramServiceLive } from "./Layers/TelegramConnector.ts";

const CONSOLE = "http://console.test";
const TGA = "tga_" + "c".repeat(64);
const OWN = "123456:own-bot-token-for-tests-only";
const CHAT = 777;
const projectId = ASSISTANT_PROJECT_ID;

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

let queued: Array<unknown> = [];
let calls: Array<Recorded> = [];
let gateway: "describe" | "old" = "describe";

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** Fake Bot API (relay mirror and api.telegram.org), console and Uno gateway. */
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
      calls.push({ method: init?.method ?? "GET", url, body });
      const path = new URL(url).pathname;
      if (path.endsWith("/video/describe")) {
        return gateway === "describe"
          ? json({ speech: "this button is broken", visual: "a settings page", duration_sec: 35 })
          : new Response("not found", { status: 404 });
      }
      if (path.endsWith("/audio/transcriptions")) return json({ text: "spoken words" });
      if (path.includes("/file/bot")) return new Response(new Uint8Array([0xff, 0xd8, 1, 2]));
      if (path.endsWith("/getFile")) {
        const fileId = new URL(url).searchParams.get("file_id");
        return json({ ok: true, result: { file_path: `media/${fileId}.bin` } });
      }
      if (path.endsWith("/getMe")) return json({ ok: true, result: { username: "uno_work_bot" } });
      if (path.endsWith("/getUpdates")) {
        if (queued.length > 0) return json({ ok: true, result: [queued.shift()] });
        await new Promise((resolve) => setTimeout(resolve, 100));
        return json({ ok: true, result: [] });
      }
      if (/\/(sendMessage|sendChatAction|unoRegisterStartCode)$/.test(path)) {
        return json({ ok: true, result: { message_id: 1 } });
      }
      return new Response("not found", { status: 404 });
    }),
  );
};

beforeEach(() => {
  vi.stubEnv(CONTROL_PLANE_URL_OVERRIDE_ENV, CONSOLE);
  queued = [];
  gateway = "describe";
  dispatched.length = 0;
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
            updatedAt: "2026-10-28T00:00:00.000Z",
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
              createdAt: "2026-10-28T00:00:00.000Z",
              updatedAt: "2026-10-28T00:00:00.000Z",
            }),
          ),
      }),
      Layer.mock(ProjectionPendingApprovalRepository)({
        listByThreadId: () => Effect.succeed([]),
      }),
      ServerSettingsService.layerTest({ uno: { apiKey: "sk-uno-test" } } as never),
      ServerConfig.layerTest(process.cwd(), { prefix: "uno-tg-assistant-bot-test-" }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const saveRow = (botToken: string, allowedChatIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    yield* repository.upsert({
      projectId,
      kind: "telegram",
      config: {
        botToken,
        allowedChatIds: [...allowedChatIds],
        ownerUserIds: allowedChatIds.length > 0 ? [String(CHAT)] : [],
        enabled: true,
        defaultModelSelection: null,
      },
      updatedAt: new Date().toISOString(),
    });
  });

const readRow = Effect.gen(function* () {
  const repository = yield* ManagerConnectorRepository;
  const row = yield* repository.get({ projectId, kind: "telegram" });
  return Option.isSome(row)
    ? Schema.decodeUnknownSync(ManagerTelegramConnectorConfig)(row.value.config)
    : null;
});

let nextId = 1;
const privateUpdate = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const id = nextId++;
  return {
    update_id: id,
    message: {
      message_id: id,
      chat: { id: CHAT, type: "private" },
      from: { id: CHAT, is_bot: false, language_code: "en" },
      ...message,
    },
    ...extra,
  };
};

const waitUntil = (check: () => boolean, attempts = 80) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (check()) return true;
      yield* Effect.sleep("100 millis");
    }
    return check();
  });

const sentTexts = () =>
  calls
    .filter((call) => call.url.endsWith("/sendMessage"))
    .map((call) => String((call.body as { text?: unknown }).text ?? ""));

const turnTexts = () =>
  dispatched.flatMap((command) =>
    command.type === "thread.turn.start" ? [command.message.text] : [],
  );

const turnAttachments = () =>
  dispatched.flatMap((command) =>
    command.type === "thread.turn.start" ? command.message.attachments : [],
  );

it.live("uno_linked on Uno's assistant bot: the chat is linked, the daemon says nothing", () =>
  Effect.gen(function* () {
    yield* saveRow(`unorelay:${TGA}`, []);
    const telegram = yield* ManagerTelegramService;
    const pairing = yield* telegram.startPairing(projectId);
    queued.push(privateUpdate({ text: `/start ${pairing.code}` }, { uno_linked: true }));
    let linked = false;
    for (let attempt = 0; attempt < 80 && !linked; attempt += 1) {
      yield* Effect.sleep("100 millis");
      linked = (yield* readRow)?.allowedChatIds.includes(String(CHAT)) === true;
    }
    expect(linked).toBe(true);
    expect((yield* readRow)?.ownerUserIds).toEqual([String(CHAT)]);
    yield* Effect.sleep("300 millis");
    expect(sentTexts()).toEqual([]);
  }).pipe(Effect.provide(connectorLayer)),
);

it.live("uno_linked means nothing on an own bot: the daemon says hello itself", () =>
  Effect.gen(function* () {
    yield* saveRow(OWN, []);
    const telegram = yield* ManagerTelegramService;
    const pairing = yield* telegram.startPairing(projectId);
    queued.push(privateUpdate({ text: `/start ${pairing.code}` }, { uno_linked: true }));
    expect(yield* waitUntil(() => sentTexts().length > 0)).toBe(true);
    expect((yield* readRow)?.allowedChatIds).toEqual([String(CHAT)]);
    expect(calls.some((call) => call.url.includes("unoRegisterStartCode"))).toBe(false);
  }).pipe(Effect.provide(connectorLayer)),
);

it.live("a 34 MB video: refused in the chat with its size, never downloaded, no turn", () =>
  Effect.gen(function* () {
    yield* saveRow(OWN, [String(CHAT)]);
    queued.push(
      privateUpdate({
        video: { file_id: "big", duration: 60, file_size: 34 * 1024 * 1024 },
      }),
    );
    expect(yield* waitUntil(() => sentTexts().length > 0)).toBe(true);
    expect(sentTexts()).toEqual([
      "This file is 34 MB: Telegram gives bots only up to 20 MB. Upload it to Uno Work or Uno Drive and tell me here: https://app.uno4.work",
    ]);
    yield* Effect.sleep("300 millis");
    expect(calls.some((call) => call.url.includes("/getFile"))).toBe(false);
    expect(turnTexts()).toEqual([]);
  }).pipe(Effect.provide(connectorLayer)),
);

it.live(
  "a too-long video with a caption: refused, but the caption still reaches the assistant",
  () =>
    Effect.gen(function* () {
      yield* saveRow(`unorelay:${TGA}`, [String(CHAT)]);
      queued.push(
        privateUpdate({
          caption: "what is wrong here?",
          video: { file_id: "long", duration: 760, file_size: 5_000_000 },
        }),
      );
      expect(yield* waitUntil(() => turnTexts().length > 0)).toBe(true);
      expect(sentTexts()).toContain(
        "This video is too long (12:40). I can take up to 10 minutes of video.",
      );
      expect(turnTexts()[0]).toContain("what is wrong here?");
      expect(turnTexts()[0]).toContain("[Not passed to you: This video is too long (12:40).");
      expect(calls.some((call) => call.url.includes("/getFile"))).toBe(false);
    }).pipe(Effect.provide(connectorLayer)),
);

it.live("a video is described by the gateway: speech and what is on screen", () =>
  Effect.gen(function* () {
    yield* saveRow(OWN, [String(CHAT)]);
    queued.push(
      privateUpdate({
        video: {
          file_id: "clip",
          duration: 35,
          file_size: 3_000_000,
          mime_type: "video/mp4",
          thumbnail: { file_id: "clip-thumb", width: 320 },
        },
      }),
    );
    expect(yield* waitUntil(() => turnTexts().length > 0)).toBe(true);
    expect(turnTexts()[0]).toContain(
      "[video, 0:35]\nSpeech: this button is broken\nOn screen: a settings page",
    );
    // Described by the gateway: no preview frame needed.
    expect(turnAttachments()).toEqual([]);
    const describe = calls.find((call) => call.url.endsWith("/video/describe"));
    expect(describe?.url).toBe("https://api.getuno.xyz/v1/video/describe");
  }).pipe(Effect.provide(connectorLayer)),
);

it.live(
  "an older gateway: the round video's sound is transcribed, its preview frame attached",
  () =>
    Effect.gen(function* () {
      gateway = "old";
      yield* saveRow(`unorelay:${TGA}`, [String(CHAT)]);
      queued.push(
        privateUpdate({
          video_note: {
            file_id: "round",
            duration: 12,
            file_size: 400_000,
            thumbnail: { file_id: "round-thumb", width: 240 },
          },
        }),
      );
      expect(yield* waitUntil(() => turnTexts().length > 0)).toBe(true);
      expect(turnTexts()[0]).toContain("[video message, 0:12]\nSpeech: spoken words");
      expect(turnAttachments()).toEqual([
        expect.objectContaining({ type: "image", name: "video-frame.jpg", mimeType: "image/jpeg" }),
      ]);
      expect(
        calls.some((call) => new URL(call.url).searchParams.get("file_id") === "round-thumb"),
      ).toBe(true);
    }).pipe(Effect.provide(connectorLayer)),
);
