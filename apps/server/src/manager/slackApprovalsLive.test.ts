/**
 * Allow / Decline in Slack (slackButtons.ts, 23.11): the real Slack connector
 * (relay mode) against a fake console relay. An approval goes out with
 * buttons; a press (block_actions through the relay queue) by the owner
 * resolves it and the message loses its buttons; anyone else, a second
 * press, another message — refused with a line only the presser sees.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "@effect/vitest";
import { ASSISTANT_PROJECT_ID, ThreadId, type OrchestrationCommand } from "@t3tools/contracts";
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
import { ServerSettingsService } from "../serverSettings.ts";
import { CONTROL_PLANE_URL_OVERRIDE_ENV } from "../workspaceRegistry/unoCloudParse.ts";
import { fastClock, MINUTE, real, waitFor } from "./connectorRepliesTestkit.ts";
import { approvalButtons } from "./connectorButtons.ts";
import { ManagerSlackService, ManagerSlackServiceLive } from "./Layers/SlackConnector.ts";

const SLR = "slr_" + "e".repeat(64);

interface Call {
  readonly method: string;
  readonly form: URLSearchParams;
}

let queue: Array<{ cursor: string; payload: unknown }> = [];
let calls: Array<Call> = [];
let nextCursor = 1;
let nextTs = 1;
let server: http.Server;
let dispatched: Array<OrchestrationCommand> = [];

const callsOf = (method: string) => calls.filter((call) => call.method === method);

const press = (input: { user: string; channel: string; ts: string; actionId: string }) => {
  const cursor = nextCursor++;
  queue.push({
    cursor: String(cursor),
    payload: {
      type: "block_actions",
      team: { id: "T1" },
      user: { id: input.user, team_id: "T1" },
      container: { type: "message", message_ts: input.ts, channel_id: input.channel },
      channel: { id: input.channel },
      message: { ts: input.ts },
      actions: [{ type: "button", action_id: input.actionId, action_ts: `9.${cursor}` }],
    },
  });
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
      response.setHeader("x-oauth-scopes", "chat:write");
      const method = url.pathname.split("/api/").at(-1) ?? "";
      calls.push({ method, form: new URLSearchParams(body) });
      if (method === "auth.test") {
        response.end(JSON.stringify({ ok: true, user_id: "UBOT", user: "uno", team_id: "T1" }));
        return;
      }
      if (method === "chat.postMessage") {
        const ts = `1700000100.${String(nextTs++).padStart(6, "0")}`;
        response.end(JSON.stringify({ ok: true, channel: "x", ts }));
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

let tmpDir = "";

beforeEach(() => {
  queue = [];
  calls = [];
  dispatched = [];
  tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-slack-approvals-"));
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
              dispatched.push(command);
              return { sequence: 1 };
            }),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 1,
              projects: [],
              threads: [],
              updatedAt: "2026-11-23T00:00:00.000Z",
            }),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        }),
        ServerSettingsService.layerTest({}),
        ServerConfig.layerTest(process.cwd(), { prefix: "uno-slack-approvals-test-" }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

const daemonRun = <A, E>(
  dbPath: string,
  body: Effect.Effect<A, E, ManagerConnectorRepository | ManagerSlackService>,
) =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    yield* repository.upsert({
      projectId: ASSISTANT_PROJECT_ID,
      kind: "slack",
      config: {
        botToken: `unorelay:${SLR}`,
        appToken: "unorelay",
        allowedChannelIds: ["DOWNER", "CTEAM"],
        enabled: true,
        ownerUserIds: ["UOWNER"],
      },
      updatedAt: new Date().toISOString(),
    });
    return yield* body;
  }).pipe(Effect.provide(makeLayer(dbPath)), Effect.provideService(Clock.Clock, fastClock));

const thread = ThreadId.make("thread-build");

/** Sends an approval with buttons once the relay connection is up; its ts and action ids. */
const sendApproval = (requestId: string, channelId: string) =>
  Effect.gen(function* () {
    const slack = yield* ManagerSlackService;
    let sent = false;
    for (let attempt = 0; attempt < 300 && !sent; attempt += 1) {
      sent = yield* slack.sendText({
        projectId: ASSISTANT_PROJECT_ID,
        channelId,
        text: "💬 Build the site: wants to run a command:\nnpm i",
        buttons: {
          rows: approvalButtons(requestId, "en"),
          threadId: thread,
          ttlMs: 60 * MINUTE,
          language: "en",
          fallbackText: "Build the site needs your approval",
        },
      });
      if (!sent) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
    }
    expect(sent).toBe(true);
    const post = callsOf("chat.postMessage").at(-1)!;
    const blocks = JSON.parse(post.form.get("blocks") ?? "[]") as Array<{
      type: string;
      elements?: Array<{ action_id?: string; style?: string; text?: { text: string } }>;
    }>;
    const actions = blocks.find((block) => block.type === "actions")?.elements ?? [];
    return {
      ts: `1700000100.${String(nextTs - 1).padStart(6, "0")}`,
      blocks,
      allow: actions[0]!,
      deny: actions[1]!,
    };
  });

it.live(
  "Allow in Slack: the owner's press resolves the approval and the buttons go; others are refused",
  () =>
    daemonRun(
      nodePath.join(tmpDir, "state.sqlite"),
      Effect.gen(function* () {
        const sent = yield* sendApproval("req-1", "CTEAM");
        expect(sent.allow.text?.text).toBe("✅ Allow");
        expect(sent.allow.style).toBe("primary");
        expect(sent.deny.style).toBe("danger");
        // The way without buttons stays under them.
        expect(JSON.stringify(sent.blocks)).toContain("Or open Uno Work to answer");

        // A member of the channel who is not the owner.
        press({ user: "UOTHER", channel: "CTEAM", ts: sent.ts, actionId: sent.allow.action_id! });
        expect(yield* waitFor(() => callsOf("chat.postEphemeral").length > 0, real(MINUTE))).toBe(
          true,
        );
        expect(callsOf("chat.postEphemeral")[0]!.form.get("text")).toBe(
          "Only the owner can answer this.",
        );
        expect(callsOf("chat.postEphemeral")[0]!.form.get("user")).toBe("UOTHER");
        expect(dispatched).toEqual([]);

        // The same action id on another message of the channel.
        press({ user: "UOWNER", channel: "CTEAM", ts: "1.1", actionId: sent.allow.action_id! });
        expect(yield* waitFor(() => callsOf("chat.postEphemeral").length > 1, real(MINUTE))).toBe(
          true,
        );
        expect(callsOf("chat.postEphemeral")[1]!.form.get("text")).toBe(
          "This button no longer works.",
        );
        expect(dispatched).toEqual([]);

        // The owner: resolved, the message says so and loses its buttons.
        press({ user: "UOWNER", channel: "CTEAM", ts: sent.ts, actionId: sent.allow.action_id! });
        expect(yield* waitFor(() => dispatched.length > 0, real(MINUTE))).toBe(true);
        expect(dispatched[0]).toMatchObject({
          type: "thread.approval.respond",
          threadId: thread,
          requestId: "req-1",
          decision: "accept",
        });
        expect(yield* waitFor(() => callsOf("chat.update").length > 0, real(MINUTE))).toBe(true);
        const update = callsOf("chat.update")[0]!.form;
        expect(update.get("ts")).toBe(sent.ts);
        expect(update.get("text")).toContain("✔ ✅ Allow");
        expect(update.get("blocks")).not.toContain("actions");

        // A second press (double tap): nothing runs twice.
        press({ user: "UOWNER", channel: "CTEAM", ts: sent.ts, actionId: sent.deny.action_id! });
        expect(yield* waitFor(() => callsOf("chat.postEphemeral").length > 2, real(MINUTE))).toBe(
          true,
        );
        expect(callsOf("chat.postEphemeral")[2]!.form.get("text")).toBe(
          "This button has expired. Answer in a message instead.",
        );
        expect(dispatched.length).toBe(1);
      }),
    ),
  90_000,
);

it.live(
  "Deny in the DM; an approval answered elsewhere loses its Slack buttons",
  () =>
    daemonRun(
      nodePath.join(tmpDir, "state.sqlite"),
      Effect.gen(function* () {
        const slack = yield* ManagerSlackService;
        const first = yield* sendApproval("req-2", "DOWNER");
        press({ user: "UOWNER", channel: "DOWNER", ts: first.ts, actionId: first.deny.action_id! });
        expect(yield* waitFor(() => dispatched.length > 0, real(MINUTE))).toBe(true);
        expect(dispatched[0]).toMatchObject({ requestId: "req-2", decision: "decline" });

        const second = yield* sendApproval("req-3", "DOWNER");
        yield* slack.retireRequestButtons("req-3");
        const update = callsOf("chat.update").find((call) => call.form.get("ts") === second.ts);
        expect(update?.form.get("text")).toContain("✔ Already answered");
        press({
          user: "UOWNER",
          channel: "DOWNER",
          ts: second.ts,
          actionId: second.allow.action_id!,
        });
        yield* waitFor(() => callsOf("chat.postEphemeral").length > 0, real(MINUTE));
        expect(dispatched.length).toBe(1);
      }),
    ),
  90_000,
);
