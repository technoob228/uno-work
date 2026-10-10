/**
 * The real Telegram connector against a fake Bot API (Uno's relay mirror on
 * localhost) and a fake harness, with a clock that runs 60× faster: what the
 * person sees in Telegram for a turn that runs 25 minutes, for a daemon
 * restart in the middle of a turn, for three messages in a row, and for an
 * answer with a file.
 *
 * Regression for "The assistant is still working on it; check the app for
 * progress." (case WORKSPACE_NOTETAKER 09.10, п.7): that line must never
 * appear, every answer must quote its own message, nothing may be lost.
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
import { fastClock, MINUTE, real, virtualNow, waitFor, World } from "./connectorRepliesTestkit.ts";
import { ManagerTelegramServiceLive } from "./Layers/TelegramConnector.ts";

// ── Fake Bot API (the relay mirror) ─────────────────────────────────────

const RELAY = "tgr_" + "a".repeat(40);
const CHAT = 4242;

interface Sent {
  readonly method: string;
  readonly text: string;
  readonly replyTo: number | null;
  readonly fileName: string | null;
  readonly atVirtualMs: number;
}

let updates: Array<{ update_id: number; message: unknown }> = [];
let sent: Array<Sent> = [];
let typing = 0;
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
        case "sendChatAction":
          typing += 1;
          return reply(true);
        case "sendMessage": {
          const payload = JSON.parse(body) as {
            text: string;
            reply_parameters?: { message_id: number };
          };
          sent.push({
            method,
            text: payload.text,
            replyTo: payload.reply_parameters?.message_id ?? null,
            fileName: null,
            atVirtualMs: virtualNow(),
          });
          return reply({ message_id: nextMessageId++ });
        }
        case "sendDocument":
        case "sendPhoto":
          sent.push({
            method,
            text: "",
            replyTo: null,
            fileName: /filename="([^"]+)"/.exec(body)?.[1] ?? null,
            atVirtualMs: virtualNow(),
          });
          return reply({ message_id: nextMessageId++ });
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

const mainThreadId = ThreadId.make("thread-uno-main");
let workspaceRoot = "";

let world = new World();
world.threadId = mainThreadId;

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
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
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
              updatedAt: "2026-10-09T00:00:00.000Z",
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
        ServerConfig.layerTest(process.cwd(), { prefix: "uno-tg-replies-test-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

/** Run `body` with the connector up (a daemon run); it stops when `body` ends. */
const daemonRun = <A, E>(dbPath: string, body: Effect.Effect<A, E, ManagerConnectorRepository>) =>
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

const answers = () => sent.filter((entry) => entry.text.startsWith("ответ:"));
const neverStillWorking = () => {
  for (const entry of sent) {
    expect(entry.text).not.toMatch(/still working on it|check the app/i);
  }
};

let tmpDir = "";
beforeEach(() => {
  world.stop();
  world = new World();
  world.threadId = mainThreadId;
  world.start();
  updates = [];
  sent = [];
  typing = 0;
  tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-tg-replies-"));
  workspaceRoot = nodePath.join(tmpDir, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
});

it.live(
  "a 25-minute turn: typing all along, rare notes in Russian, then the real answer quoting the message",
  () =>
    Effect.gen(function* () {
      const dbPath = nodePath.join(tmpDir, "state.sqlite");
      const longAnswer = "ответ: " + "очень длинный ответ. ".repeat(500);
      world.script = () => ({ durationMs: 25 * MINUTE, answer: longAnswer });
      yield* daemonRun(
        dbPath,
        Effect.gen(function* () {
          yield* connect;
          const asked = say("почему у коллеги не получается поставить notetaker?");
          expect(yield* waitFor(() => answers().length > 0, real(40 * MINUTE))).toBe(true);
          // Every part of the long answer arrived (nothing cut at 4000).
          yield* waitFor(
            () => sent.filter((entry) => entry.atVirtualMs > 0).length >= 5,
            real(2 * MINUTE),
          );
          const answerParts = sent.filter(
            (entry) => entry.method === "sendMessage" && !/^(Работаю|Всё ещё)/.test(entry.text),
          );
          expect(
            answerParts
              .map((entry) => entry.text)
              .join(" ")
              .replace(/\s+/g, " "),
          ).toBe(longAnswer.trim().replace(/\s+/g, " "));
          expect(answerParts.every((entry) => entry.text.length <= 4000)).toBe(true);
          expect(answerParts[0]?.replyTo).toBe(asked);

          const notes = sent.filter((entry) => /^(Работаю|Всё ещё)/.test(entry.text));
          // 3 and 15 minutes in; no more for a 25-minute turn.
          expect(notes.map((entry) => entry.text.slice(0, 20))).toEqual([
            "Работаю над этим уже",
            "Всё ещё работаю (15 ",
          ]);
          expect(notes.every((entry) => entry.replyTo === asked)).toBe(true);
          // "typing…" renewed every few seconds for 25 minutes.
          expect(typing).toBeGreaterThan(100);
          neverStillWorking();
        }),
      );
    }),
  120_000,
);

it.live(
  "a daemon restart in the middle of a turn: the turn runs again and the answer still reaches the message",
  () =>
    Effect.gen(function* () {
      const dbPath = nodePath.join(tmpDir, "state.sqlite");
      world.script = (text) =>
        text.includes("[Uno Work restarted")
          ? { durationMs: 2 * MINUTE, answer: "ответ: после рестарта" }
          : { durationMs: 20 * MINUTE, answer: "ответ: без рестарта (не должен прийти)" };
      const asked = yield* daemonRun(
        dbPath,
        Effect.gen(function* () {
          yield* connect;
          const id = say("сделай https для notetaker");
          // Into the turn, past the first progress note.
          expect(yield* waitFor(() => world.running !== null, real(2 * MINUTE))).toBe(true);
          expect(
            yield* waitFor(
              () => sent.some((entry) => entry.text.startsWith("Работаю")),
              real(6 * MINUTE),
            ),
          ).toBe(true);
          return id;
        }),
      );
      // The daemon is gone: the harness lost the turn, reconciliation marks it.
      world.restart();
      const notesBefore = sent.filter((entry) => /^(Работаю|Всё ещё)/.test(entry.text)).length;

      yield* daemonRun(
        dbPath,
        Effect.gen(function* () {
          expect(yield* waitFor(() => answers().length > 0, real(10 * MINUTE))).toBe(true);
          expect(answers()).toEqual([
            expect.objectContaining({ text: "ответ: после рестарта", replyTo: asked }),
          ]);
          // The re-run carried the original message.
          expect(world.dispatchedTexts.at(-1)).toContain("[Uno Work restarted");
          expect(world.dispatchedTexts.at(-1)).toContain("сделай https для notetaker");
          // The first note is not repeated after the restart.
          expect(sent.filter((entry) => entry.text.startsWith("Работаю над этим уже")).length).toBe(
            notesBefore,
          );
          neverStillWorking();
        }),
      );
    }),
  120_000,
);

it.live(
  "three messages in a row: three turns, three answers, each quoting its own message, in order",
  () =>
    Effect.gen(function* () {
      const dbPath = nodePath.join(tmpDir, "state.sqlite");
      world.script = (text) => ({
        durationMs: 2 * MINUTE,
        answer: `ответ: ${text.split("\n")[0]}`,
      });
      yield* daemonRun(
        dbPath,
        Effect.gen(function* () {
          yield* connect;
          const first = say("первый вопрос");
          const second = say("второй вопрос");
          const third = say("третий вопрос");
          expect(yield* waitFor(() => answers().length >= 3, real(20 * MINUTE))).toBe(true);
          expect(answers().map((entry) => [entry.text, entry.replyTo])).toEqual([
            ["ответ: первый вопрос", first],
            ["ответ: второй вопрос", second],
            ["ответ: третий вопрос", third],
          ]);
          // One turn each — never two answers for one message.
          expect(world.turnCount).toBe(3);
          // The queued ones heard they wait for the current task.
          const queued = sent.filter((entry) => entry.text.startsWith("Получил."));
          expect(queued.map((entry) => entry.replyTo).toSorted()).toEqual(
            [second, third].toSorted(),
          );
          // Two-minute turns: no progress note, not even for the third, which
          // waited four minutes in the queue (it heard "Получил." instead).
          expect(sent.filter((entry) => /^(Работаю|Всё ещё)/.test(entry.text))).toEqual([]);
          neverStillWorking();
        }),
      );
    }),
  120_000,
);

it.live(
  "an answer with a file: the text quotes the message, the file follows",
  () =>
    Effect.gen(function* () {
      const dbPath = nodePath.join(tmpDir, "state.sqlite");
      const report = nodePath.join(workspaceRoot, "report.txt");
      fs.writeFileSync(report, "notetaker report");
      world.script = () => ({
        durationMs: MINUTE,
        answer: `ответ: отчёт готов\n\n[[send-file: ${report}]]`,
      });
      yield* daemonRun(
        dbPath,
        Effect.gen(function* () {
          yield* connect;
          const asked = say("пришли отчёт");
          expect(
            yield* waitFor(
              () => sent.some((entry) => entry.method === "sendDocument"),
              real(10 * MINUTE),
            ),
          ).toBe(true);
          const answer = answers()[0];
          expect(answer).toMatchObject({ text: "ответ: отчёт готов", replyTo: asked });
          const file = sent.find((entry) => entry.method === "sendDocument");
          expect(file?.fileName).toBe("report.txt");
          expect(sent.indexOf(file!)).toBeGreaterThan(sent.indexOf(answer!));
          neverStillWorking();
        }),
      );
    }),
  120_000,
);
