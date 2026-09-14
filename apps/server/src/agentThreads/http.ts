/**
 * HTTP surface of the agent-threads bridge (see `service.ts` for the rules):
 *
 * - `POST /api/threads`                   — spawn a thread and start its first turn;
 * - `GET  /api/threads`                   — the caller's child threads;
 * - `GET  /api/threads/:threadId`         — status + last messages, `?limit`, `?waitMs` long-poll;
 * - `POST /api/threads/:threadId/messages` — send a turn (409 when a human took over);
 * - `POST /api/threads/:threadId/release` — hand control to the human.
 *
 * Authenticated with the thread-scoped browser-bridge token every harness
 * process holds (`UNO_WORK_BRIDGE_TOKEN`), like `POST /api/channels/notify`.
 */
import { Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { BrowserBridge } from "../browserBridge.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AGENT_THREADS_PATH } from "./logic.ts";
import { type AgentThreadsReply, makeAgentThreadsHandlers } from "./service.ts";

const makeRequestContext = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const browserBridge = yield* BrowserBridge;
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  const handlers = makeAgentThreadsHandlers({
    engine,
    projections,
    // Unreadable settings fall back to the narrow default.
    getAgentThreadsScope: serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.agentThreadsScope),
      Effect.orElseSucceed(() => "own-project" as const),
    ),
    getProviders: providerRegistry.getProviders,
  });
  return {
    request,
    handlers,
    authorization: browserBridge.authorize(request.headers["authorization"]),
  };
});

const readJsonBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.json.pipe(Effect.catch(() => Effect.succeed(null)));

const searchParam = (request: HttpServerRequest.HttpServerRequest, name: string) => {
  const url = HttpServerRequest.toURL(request);
  return Option.isSome(url) ? url.value.searchParams.get(name) : null;
};

const respond = (reply: AgentThreadsReply) =>
  HttpServerResponse.jsonUnsafe(reply.body, {
    status: reply.status,
    headers: { "cache-control": "no-store" },
  });

export const agentThreadsCreateRouteLayer = HttpRouter.add(
  "POST",
  AGENT_THREADS_PATH,
  Effect.gen(function* () {
    const { request, handlers, authorization } = yield* makeRequestContext;
    const body = authorization === null ? null : yield* readJsonBody(request);
    return respond(yield* handlers.createThread(authorization, body));
  }),
);

export const agentThreadsListRouteLayer = HttpRouter.add(
  "GET",
  AGENT_THREADS_PATH,
  Effect.gen(function* () {
    const { handlers, authorization } = yield* makeRequestContext;
    return respond(yield* handlers.listThreads(authorization));
  }),
);

export const agentThreadsGetRouteLayer = HttpRouter.add(
  "GET",
  `${AGENT_THREADS_PATH}/:threadId`,
  Effect.gen(function* () {
    const { request, handlers, authorization } = yield* makeRequestContext;
    const params = yield* HttpRouter.params;
    return respond(
      yield* handlers.getThread(authorization, {
        threadId: params["threadId"],
        limit: searchParam(request, "limit"),
        waitMs: searchParam(request, "waitMs"),
      }),
    );
  }),
);

export const agentThreadsSendMessageRouteLayer = HttpRouter.add(
  "POST",
  `${AGENT_THREADS_PATH}/:threadId/messages`,
  Effect.gen(function* () {
    const { request, handlers, authorization } = yield* makeRequestContext;
    const params = yield* HttpRouter.params;
    const body = authorization === null ? null : yield* readJsonBody(request);
    return respond(
      yield* handlers.sendMessage(authorization, { threadId: params["threadId"], body }),
    );
  }),
);

export const agentThreadsReleaseRouteLayer = HttpRouter.add(
  "POST",
  `${AGENT_THREADS_PATH}/:threadId/release`,
  Effect.gen(function* () {
    const { handlers, authorization } = yield* makeRequestContext;
    const params = yield* HttpRouter.params;
    return respond(yield* handlers.releaseThread(authorization, { threadId: params["threadId"] }));
  }),
);
