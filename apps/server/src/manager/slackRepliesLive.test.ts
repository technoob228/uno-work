/**
 * The real Slack connector (relay mode) against a fake console relay and the
 * fake harness of `connectorRepliesTestkit.ts`, at 60× speed: a long turn in
 * a DM gets the ⏳ reaction and rare notes instead of "still working", two
 * messages in a row get two answers, each under its own message.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "@effect/vitest";
import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";
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
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CONTROL_PLANE_URL_OVERRIDE_ENV } from "../workspaceRegistry/unoCloudParse.ts";
import { fastClock, MINUTE, real, waitFor, World } from "./connectorRepliesTestkit.ts";
import { ManagerSlackServiceLive } from "./Layers/SlackConnector.ts";

const SLR = "slr_" + "d".repeat(64);

interface Posted {
  readonly text: string;
  readonly threadTs: string | null;
  readonly broadcast: boolean;
}

let queue: Array<{ cursor: string; payload: unknown }> = [];
let posted: Array<Posted> = [];
let reactions: Array<{ readonly op: "add" | "remove"; readonly ts: string }> = [];
let nextCursor = 1;
let server: http.Server;

const dm = (text: string) => {
  const cursor = nextCursor++;
  const ts = `1700000000.${String(cursor).padStart(6, "0")}`;
  queue.push({
    cursor: String(cursor),
    payload: {
      type: "event_callback",
      event_id: `Ev${cursor}`,
      event: { type: "message", channel: "DOWNER", channel_type: "im", user: "UOWNER", text, ts },
    },
  });
  return ts;
};

beforeAll(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://relay.test");
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (url.pathname.endsWith("/events")) {
        const after = Number(url.searchParams.get("after") ?? "0");
        const events = queue.filter((entry) => Number(entry.cursor) > after);
        setTimeout(
          () =>
            response.end(
              JSON.stringify({ events, cursor: events.at(-1)?.cursor ?? String(after) }),
            ),
          events.length > 0 ? 0 : 100,
        );
        return;
      }
      response.setHeader("x-oauth-scopes", "chat:write,reactions:write");
      const form = new URLSearchParams(body);
      if (url.pathname.endsWith("/api/auth.test")) {
        response.end(JSON.stringify({ ok: true, user_id: "UBOT", user: "uno", team_id: "T1" }));
        return;
      }
      if (url.pathname.endsWith("/api/chat.postMessage")) {
        posted.push({
          text: form.get("text") ?? "",
          threadTs: form.get("thread_ts"),
          broadcast: form.get("reply_broadcast") === "true",
        });
        response.end(JSON.stringify({ ok: true, ts: "1700000099.000001" }));
        return;
      }
      if (url.pathname.endsWith("/api/reactions.add")) {
        reactions.push({ op: "add", ts: form.get("timestamp") ?? "" });
      }
      if (url.pathname.endsWith("/api/reactions.remove")) {
        reactions.push({ op: "remove", ts: form.get("timestamp") ?? "" });
      }
      response.end(JSON.stringify({ ok: true }));
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

let world = new World();
let tmpDir = "";
/** The DM's thread as the projection would show it. */
let threadShell: { readonly id: string; readonly [key: string]: unknown } | null = null;

beforeEach(() => {
  world.stop();
  world = new World();
  world.start();
  threadShell = null;
  queue = [];
  posted = [];
  reactions = [];
  tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-slack-replies-"));
});

const makeLayer = (dbPath: string) => {
  const repositories = Layer.mergeAll(
    ManagerConnectorRepositoryLive,
    ManagerConnectorBindingRepositoryLive,
    ProjectionTurnRepositoryLive,
  ).pipe(Layer.provideMerge(makeSqlitePersistenceLive(dbPath)));
  return ManagerSlackServiceLive.pipe(
    Layer.provideMerge(repositories),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "thread.create") {
                threadShell = {
                  id: command.threadId,
                  projectId: command.projectId,
                  archivedAt: null,
                  modelSelection: command.modelSelection,
                  runtimeMode: command.runtimeMode,
                  interactionMode: command.interactionMode,
                };
              }
              world.dispatch(command);
              return { sequence: 1 };
            }),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [],
              threads: [],
              updatedAt: "2026-10-09T00:00:00.000Z",
            }),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getThreadShellById: (id) =>
            Effect.succeed(
              threadShell !== null && id === threadShell.id
                ? Option.some(threadShell as never)
                : Option.none(),
            ),
          getThreadDetailById: (id) =>
            Effect.succeed(id === world.threadId ? Option.some(world.detail()) : Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        }),
        ServerSettingsService.layerTest({}),
        ServerConfig.layerTest(process.cwd(), { prefix: "uno-slack-replies-test-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

const daemonRun = <A, E>(dbPath: string, body: Effect.Effect<A, E, ManagerConnectorRepository>) =>
  Effect.gen(function* () {
    world.turns = yield* ProjectionTurnRepository;
    const repository = yield* ManagerConnectorRepository;
    yield* repository.upsert({
      projectId: ASSISTANT_PROJECT_ID,
      kind: "slack",
      config: {
        botToken: `unorelay:${SLR}`,
        appToken: "unorelay",
        allowedChannelIds: ["DOWNER"],
        enabled: true,
        ownerUserIds: ["UOWNER"],
      },
      updatedAt: new Date().toISOString(),
    });
    return yield* body;
  }).pipe(Effect.provide(makeLayer(dbPath)), Effect.provideService(Clock.Clock, fastClock));

const answers = () => posted.filter((entry) => entry.text.startsWith("ответ:"));

it.live(
  "a long turn in a DM: ⏳ on the message, rare notes, then the answer — never 'still working'",
  () =>
    Effect.gen(function* () {
      world.script = () => ({ durationMs: 20 * MINUTE, answer: "ответ: всё готово" });
      yield* daemonRun(
        nodePath.join(tmpDir, "state.sqlite"),
        Effect.gen(function* () {
          const ts = dm("проверь notetaker, почему не ставится");
          expect(yield* waitFor(() => answers().length > 0, real(30 * MINUTE))).toBe(true);
          expect(answers()).toEqual([
            { text: "ответ: всё готово", threadTs: null, broadcast: false },
          ]);
          yield* waitFor(() => reactions.length >= 2, real(MINUTE));
          expect(reactions).toEqual([
            { op: "add", ts },
            { op: "remove", ts },
          ]);
          const notes = posted.filter((entry) => /^(Работаю|Всё ещё)/.test(entry.text));
          expect(notes.length).toBe(2);
          for (const entry of posted) {
            expect(entry.text).not.toMatch(/still working on it|check the app/i);
          }
        }),
      );
    }),
  90_000,
);

it.live(
  "two DM messages in a row: two answers, the earlier one threaded under its own message",
  () =>
    Effect.gen(function* () {
      world.script = (text) => ({
        durationMs: 2 * MINUTE,
        answer: `ответ: ${text.split("\n")[0]}`,
      });
      yield* daemonRun(
        nodePath.join(tmpDir, "state.sqlite"),
        Effect.gen(function* () {
          const first = dm("первый");
          yield* waitFor(() => world.turnCount > 0, real(MINUTE));
          dm("второй");
          const both = yield* waitFor(() => answers().length >= 2, real(20 * MINUTE));
          expect(both).toBe(true);
          expect(answers()).toEqual([
            // The person wrote more since: under its own message, still shown in the DM.
            { text: "ответ: первый", threadTs: first, broadcast: true },
            { text: "ответ: второй", threadTs: null, broadcast: false },
          ]);
          expect(world.turnCount).toBe(2);
        }),
      );
    }),
  90_000,
);
