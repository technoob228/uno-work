/**
 * HTTP surface of the agent-threads bridge (see `service.ts` for the rules):
 *
 * - `POST /api/threads`                   — spawn a thread and start its first turn;
 * - `GET  /api/threads`                   — `?scope=children|project|all`, default the caller's children;
 * - `GET  /api/threads/:threadId`         — status + last messages, `?limit`, `?waitMs` long-poll;
 * - `POST /api/threads/:threadId/messages` — send a turn to a child or a peer (409 when the
 *   person closed the chat to agents / is asked there, or the chat is busy; `waitMs` waits
 *   for a busy one);
 * - `POST /api/threads/:threadId/release` — hand control to the human.
 *
 * Authenticated with the thread-scoped browser-bridge token every harness
 * process holds (`UNO_WORK_BRIDGE_TOKEN`), like `POST /api/channels/notify`.
 *
 * A `computerId` of another computer of the account, and thread ids
 * `box-N:<id>`, go to that computer (`crossComputer/agentRemoteChats.ts`).
 */
import { ASSISTANT_PROJECT_ID, assistantTokenLabel } from "@t3tools/contracts";
import { Effect, Option } from "effect";
import * as OS from "node:os";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { BrowserBridge } from "../browserBridge.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerCapabilityTokenRepository } from "../persistence/Services/ManagerCapabilityTokens.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AGENT_THREADS_PATH } from "./logic.ts";
import { ownBoxIdFromSettings } from "../assistants/targetComputer.ts";
import { daemonRemoteSessions, makeAgentRemoteChats } from "../crossComputer/agentRemoteChats.ts";
import { RemoteWorkError } from "../crossComputer/remoteWork.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { fetchControlPlaneJson } from "../workspaceRegistry/unoCloudParse.ts";
import { UnoCloudService } from "../workspaceRegistry/UnoCloudService.ts";
import { type AgentThreadsReply, makeAgentThreadsHandlers } from "./service.ts";

const makeRequestContext = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const browserBridge = yield* BrowserBridge;
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  const tokenRepository = yield* ManagerCapabilityTokenRepository;
  const serverEnvironment = yield* ServerEnvironment;
  const unoCloud = yield* UnoCloudService;
  const getOwnBoxId = serverSettings.getSettings.pipe(
    Effect.map((settings) => ownBoxIdFromSettings(settings.uno)),
    Effect.orElseSucceed(() => null),
  );
  const remoteChats = makeAgentRemoteChats({
    getPolicy: serverSettings.getSettings.pipe(
      Effect.map((settings) => ({
        apiKey: settings.uno.apiKey.trim(),
        agentAccessOff: settings.uno.agentAccess === "off",
        otherComputersAllowed: settings.agentsUseOtherComputers,
      })),
      // Unreadable settings: nothing leaves this computer.
      Effect.orElseSucceed(() => ({
        apiKey: "",
        agentAccessOff: true,
        otherComputersAllowed: false,
      })),
    ),
    // The account's computers through the daemon's own (cached, 20 s) read;
    // a name the agent just learned may need a fresh one.
    listComputers: async () => {
      const state = await Effect.runPromise(unoCloud.getState({ refresh: true }));
      if (state.boxes.length === 0 && state.error) {
        throw new RemoteWorkError(
          502,
          "computers_unavailable",
          `Uno did not list the computers: ${state.error}`,
        );
      }
      return state.boxes;
    },
    getOwnBoxId,
    getOwnLabel: serverEnvironment.getDescriptor.pipe(
      Effect.map((descriptor) => descriptor.label),
      Effect.orElseSucceed(() => "another computer"),
    ),
    makeRemoteDeps: (apiKey) => ({
      fetch: globalThis.fetch,
      controlPlane: (path, init) => fetchControlPlaneJson(apiKey, path, init),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    }),
    cache: daemonRemoteSessions,
    home: OS.homedir(),
  });
  const handlers = makeAgentThreadsHandlers({
    engine,
    projections,
    // Unreadable settings fall back to the narrow default.
    getAgentThreadsScope: serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.agentThreadsScope),
      Effect.orElseSucceed(() => "own-project" as const),
    ),
    // Settings → Assistant → "Can see and manage": the assistant token's
    // project allowlist is the single source (uno-manager enforces the same).
    // No token / unreadable → only the caller's own project, never "all".
    getAssistantProjectAllowlist: tokenRepository
      .getActiveByLabel(assistantTokenLabel(ASSISTANT_PROJECT_ID))
      .pipe(
        Effect.map((token): "all" | ReadonlyArray<string> =>
          Option.isSome(token) ? token.value.projectAllowlist : [],
        ),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      ),
    getProviders: providerRegistry.getProviders,
    getOwnBoxId,
    remoteChats,
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
    const { request, handlers, authorization } = yield* makeRequestContext;
    return respond(
      yield* handlers.listThreads(authorization, { scope: searchParam(request, "scope") }),
    );
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
