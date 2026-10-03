/**
 * Two assistants of one computer in one Slack workspace through ONE Uno app
 * (decision 02.10), with the real Slack connector against a local fake of the
 * console relay (events queue + Web API): a DM first asks "who is this for?",
 * naming Ana binds the DM, Ana answers under her own name, and the message
 * that waited lands in Ana's workspace.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, expect, it, vi } from "@effect/vitest";
import { ASSISTANT_PROJECT_ID, ProjectId } from "@t3tools/contracts";
import { Effect, Layer, Option, Stream } from "effect";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorBindingRepositoryLive } from "../persistence/Layers/ManagerConnectorBindings.ts";
import { ManagerConnectorRepositoryLive } from "../persistence/Layers/ManagerConnectors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ManagerConnectorBindingRepository } from "../persistence/Services/ManagerConnectorBindings.ts";
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CONTROL_PLANE_URL_OVERRIDE_ENV } from "../workspaceRegistry/unoCloudParse.ts";
import { ManagerSlackServiceLive } from "./Layers/SlackConnector.ts";

const SLR = "slr_" + "c".repeat(64);
const ana = ProjectId.make("assistant-ana");

interface Posted {
  readonly channel: string;
  readonly text: string;
  readonly username: string | null;
  readonly icon: string | null;
}

const queue: Array<{ cursor: string; payload: unknown }> = [];
const posted: Array<Posted> = [];
let server: http.Server;

const dm = (cursor: number, text: string) => ({
  cursor: String(cursor),
  payload: {
    type: "event_callback",
    event_id: `Ev${cursor}`,
    event: {
      type: "message",
      channel: "DOWNER",
      channel_type: "im",
      user: "UOWNER",
      text,
      ts: `1700000000.00${cursor}`,
    },
  },
});

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
          events.length > 0 ? 0 : 150,
        );
        return;
      }
      response.setHeader("x-oauth-scopes", "chat:write,chat:write.customize");
      if (url.pathname.endsWith("/api/auth.test")) {
        response.end(JSON.stringify({ ok: true, user_id: "UBOT", user: "uno", team_id: "T1" }));
        return;
      }
      if (url.pathname.endsWith("/api/chat.postMessage")) {
        const form = new URLSearchParams(body);
        posted.push({
          channel: form.get("channel") ?? "",
          text: form.get("text") ?? "",
          username: form.get("username"),
          icon: form.get("icon_emoji"),
        });
        response.end(JSON.stringify({ ok: true, ts: "1700000001.000001" }));
        return;
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

const dispatched: Array<{ type: string; projectId?: string }> = [];
const repositories = Layer.mergeAll(
  ManagerConnectorRepositoryLive,
  ManagerConnectorBindingRepositoryLive,
).pipe(Layer.provideMerge(SqlitePersistenceMemory));

const project = (id: ProjectId, title: string) => ({
  id,
  title,
  workspaceRoot: `/tmp/uno-slack-live-${title}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-02T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
});

const slackLayer = ManagerSlackServiceLive.pipe(
  Layer.provideMerge(repositories),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(OrchestrationEngineService)({
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push({
              type: command.type,
              ...("projectId" in command ? { projectId: command.projectId } : {}),
            });
            return { sequence: dispatched.length };
          }),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [],
            threads: [],
            updatedAt: "2026-10-02T00:00:00.000Z",
          }),
        getProjectShellById: (id) =>
          Effect.succeed(
            id === ana
              ? Option.some(project(ana, "Ana"))
              : id === ASSISTANT_PROJECT_ID
                ? Option.some(project(ASSISTANT_PROJECT_ID, "Uno"))
                : Option.none(),
          ),
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
      }),
      ServerSettingsService.layerTest({}),
      ServerConfig.layerTest(process.cwd(), { prefix: "uno-slack-live-test-" }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const waitFor = (check: () => boolean, ms = 15_000) =>
  Effect.promise(async () => {
    const until = Date.now() + ms;
    while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    return check();
  });

it.live(
  "a DM asks who it is for, then Ana answers under her own name in her workspace",
  () =>
    Effect.gen(function* () {
      const repository = yield* ManagerConnectorRepository;
      const now = new Date().toISOString();
      yield* repository.upsert({
        projectId: ASSISTANT_PROJECT_ID,
        kind: "slack",
        config: {
          botToken: `unorelay:${SLR}`,
          appToken: "unorelay",
          allowedChannelIds: ["DOWNER", "CGENERAL"],
          enabled: true,
          ownerUserIds: ["UOWNER"],
        },
        updatedAt: now,
      });
      yield* repository.upsert({
        projectId: ana,
        kind: "slack",
        config: {
          botToken: `unoroute:${ASSISTANT_PROJECT_ID}`,
          appToken: "unorelay",
          allowedChannelIds: ["CSALES"],
          enabled: true,
        },
        updatedAt: now,
      });

      queue.push(dm(1, "hello, draft a post"));
      expect(yield* waitFor(() => posted.some((p) => p.text.startsWith("Who is this for?")))).toBe(
        true,
      );
      expect(dispatched.some((command) => command.type === "thread.create")).toBe(false);

      queue.push(dm(2, "Ana"));
      expect(
        yield* waitFor(() => dispatched.some((command) => command.type === "thread.create")),
      ).toBe(true);
      const confirm = posted.find((p) => p.text.startsWith("OK — Ana answers here"));
      expect(confirm).toMatchObject({ channel: "DOWNER", username: "Ana", icon: ":robot_face:" });
      // The scopes header says the app may write as Ana: no name prefix.
      expect(confirm?.text.startsWith("*Ana:*")).toBe(false);
      expect(dispatched.find((command) => command.type === "thread.create")).toEqual({
        type: "thread.create",
        projectId: ana,
      });
      const bindings = yield* ManagerConnectorBindingRepository;
      expect(
        Option.getOrNull(yield* bindings.get({ kind: "slack", chatId: "DOWNER" })),
      ).toMatchObject({
        connectorProjectId: ASSISTANT_PROJECT_ID,
        target: { kind: "assistant", projectId: ana },
      });
    }).pipe(Effect.provide(slackLayer)),
  30_000,
);
