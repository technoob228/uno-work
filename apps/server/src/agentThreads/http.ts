/**
 * HTTP surface of the agent-threads bridge (see `service.ts` for the rules):
 *
 * - `POST /api/threads`                   — spawn a thread and start its first turn;
 * - `GET  /api/threads`                   — `?scope=children|project|all`, default the caller's children;
 * - `GET  /api/threads/:threadId`         — status + last messages, `?limit`, `?waitMs` long-poll,
 *                                            `?before` to page back, `?textOffset` to read on;
 * - `POST /api/threads/:threadId/messages` — send a turn to a child or a peer (409 when the
 *   person closed the chat to agents / is asked there, or the chat is busy; `waitMs` waits
 *   for a busy one);
 * - `POST /api/threads/:threadId/release` — hand control to the human.
 *
 * Authenticated with the thread-scoped browser-bridge token every harness
 * process holds (`UNO_WORK_BRIDGE_TOKEN`), like `POST /api/channels/notify`.
 */
import * as os from "node:os";

import { ProjectId } from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { assistantOfThread } from "../assistants/assistantAccess.ts";
import { authorizeLocalBridgeRequest, BrowserBridge } from "../browserBridge.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerCapabilityTokenRepository } from "../persistence/Services/ManagerCapabilityTokens.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AGENT_THREADS_PATH } from "./logic.ts";
import { ownBoxIdFromSettings } from "../assistants/targetComputer.ts";
import { readTeam } from "../assistants/teamStore.ts";
import { AssistantPushService } from "../manager/Services/AssistantPush.ts";
import { remoteComputersOption } from "../remoteComputers/RemoteComputers.ts";
import { assistantDisplayName } from "../remoteComputers/remoteChatHost.ts";
import { selectAutoBootstrapModelSelection } from "../provider/autoBootstrapModelSelection.ts";
import { ManagerAccountDefaultAi } from "../manager/Layers/AccountDefaultAi.ts";
import { makeRegisterFolder } from "./registerFolder.ts";
import { type AgentThreadsReply, makeAgentThreadsHandlers } from "./service.ts";

const makeRequestContext = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const browserBridge = yield* BrowserBridge;
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry;
  const tokenRepository = yield* ManagerCapabilityTokenRepository;
  const config = yield* ServerConfig;
  const remoteComputers = yield* remoteComputersOption;
  const push = Option.getOrNull(yield* Effect.serviceOption(AssistantPushService));
  const accountDefaultAi = Option.getOrNull(yield* Effect.serviceOption(ManagerAccountDefaultAi));
  const handlers = makeAgentThreadsHandlers({
    engine,
    projections,
    // Unreadable settings fall back to the narrow default.
    getAgentThreadsScope: serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.agentThreadsScope),
      Effect.orElseSucceed(() => "own-project" as const),
    ),
    // Whose chat is calling: an assistant's (its preset and projects, from
    // its own token — uno-manager enforces the same) or the person's.
    // Unreadable → treated as the person's chat: the narrow global setting.
    getCallerAssistant: (caller) =>
      projections.getShellSnapshot().pipe(
        Effect.flatMap((snapshot) =>
          assistantOfThread(
            { tokens: tokenRepository, stateDir: config.stateDir, threads: snapshot.threads },
            caller.id,
          ),
        ),
        Effect.orElseSucceed(() => null),
      ),
    getProviders: providerRegistry.getProviders,
    getHarnessUnoCredits: serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.harnessUnoCredits),
      Effect.orElseSucceed(() => ({})),
    ),
    ...(accountDefaultAi === null
      ? {}
      : { personalDefault: accountDefaultAi.spawnModelSelection() }),
    registerFolder: makeRegisterFolder({
      engine,
      projections,
      defaultModelSelection: providerRegistry.getProviders.pipe(
        Effect.map(selectAutoBootstrapModelSelection),
        Effect.orElseSucceed(() => null),
      ),
      home: os.homedir(),
    }),
    getOwnBoxId: serverSettings.getSettings.pipe(
      Effect.map((settings) => ownBoxIdFromSettings(settings.uno)),
      Effect.orElseSucceed(() => null),
    ),
    ...(remoteComputers === null
      ? {}
      : {
          remote: {
            resolveTarget: remoteComputers.resolveTarget,
            startChat: remoteComputers.startChat,
            assistantName: (projectId: string) =>
              Effect.gen(function* () {
                const project = yield* projections
                  .getProjectShellById(ProjectId.make(projectId))
                  .pipe(Effect.orElseSucceed(() => Option.none()));
                const team = yield* Effect.promise(() => readTeam(config.stateDir, projectId)).pipe(
                  Effect.orElseSucceed(() => null),
                );
                return assistantDisplayName(
                  projectId,
                  Option.isSome(project) ? project.value.title : "",
                  team?.name ?? null,
                );
              }),
            watch: (input) => (push === null ? Effect.void : push.watchRemote(input)),
            home: os.homedir(),
          },
        }),
  });
  return {
    request,
    handlers,
    authorization: authorizeLocalBridgeRequest(browserBridge, request),
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
        before: searchParam(request, "before"),
        textOffset: searchParam(request, "textOffset"),
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

export const agentThreadsCallPersonRouteLayer = HttpRouter.add(
  "POST",
  `${AGENT_THREADS_PATH}/:threadId/call-person`,
  Effect.gen(function* () {
    const { request, handlers, authorization } = yield* makeRequestContext;
    const params = yield* HttpRouter.params;
    const body = authorization === null ? null : yield* readJsonBody(request);
    return respond(
      yield* handlers.callPerson(authorization, { threadId: params["threadId"], body }),
    );
  }),
);

export const agentThreadsPersonNotNeededRouteLayer = HttpRouter.add(
  "POST",
  `${AGENT_THREADS_PATH}/:threadId/person-not-needed`,
  Effect.gen(function* () {
    const { handlers, authorization } = yield* makeRequestContext;
    const params = yield* HttpRouter.params;
    return respond(
      yield* handlers.personNotNeeded(authorization, { threadId: params["threadId"] }),
    );
  }),
);
