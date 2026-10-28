/**
 * HTTP routes of the receiving side of cross-computer chats (see
 * `remoteChatHost.ts`), owner sessions only:
 *
 * - `POST /api/manager/remote-chats`           (`ManagerRemoteChatCreateInput` → `ManagerRemoteChatResult`)
 * - `GET  /api/manager/remote-chats/:threadId` (→ `ManagerRemoteChatStatus`)
 * - `GET  /api/manager/started-by`             (→ `ManagerStartedByList`, read by the sidebar)
 *
 * The calling daemon is an owner session paired through the console's
 * `work/session`, exactly like the person's own browser.
 *
 * @module remoteComputers/http
 */
import { ManagerRemoteChatCreateInput } from "@t3tools/contracts";
import { Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { readStartedChats } from "../assistants/localAssistantStore.ts";
import { readTeam } from "../assistants/teamStore.ts";
import { ServerConfig } from "../config.ts";
import { authenticateOwnerSession, respondToAuthError } from "../manager/http.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { REMOTE_CHATS_PATH } from "./RemoteComputers.ts";
import {
  assistantDisplayName,
  makeRemoteChatHost,
  type RemoteChatHostReply,
} from "./remoteChatHost.ts";
import { readIncomingRemoteChats, recordIncomingRemoteChat } from "./remoteChatStore.ts";

export const STARTED_BY_PATH = "/api/manager/started-by";

const makeHost = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const providers = yield* ProviderRegistry;
  const { stateDir } = yield* ServerConfig;
  return makeRemoteChatHost({
    engine,
    projections,
    getProviders: providers.getProviders,
    incoming: {
      record: (entry) =>
        Effect.promise(() => recordIncomingRemoteChat(stateDir, entry)).pipe(
          Effect.ignoreCause({ log: true }),
        ),
      list: Effect.promise(() => readIncomingRemoteChats(stateDir)).pipe(
        Effect.orElseSucceed(() => []),
      ),
    },
    startedChats: Effect.promise(() => readStartedChats(stateDir)).pipe(
      Effect.orElseSucceed(() => new Map<string, string>()),
    ),
    assistantName: (projectId, projectTitle) =>
      Effect.promise(() => readTeam(stateDir, projectId)).pipe(
        Effect.map((team) => assistantDisplayName(projectId, projectTitle, team.name)),
        Effect.orElseSucceed(() => assistantDisplayName(projectId, projectTitle, null)),
      ),
  });
});

const respond = (reply: RemoteChatHostReply) =>
  HttpServerResponse.jsonUnsafe(reply.body, {
    status: reply.status,
    headers: { "cache-control": "no-store" },
  });

export const remoteChatCreateRouteLayer = HttpRouter.add(
  "POST",
  REMOTE_CHATS_PATH,
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
    const input = Schema.decodeUnknownOption(ManagerRemoteChatCreateInput)(body);
    if (Option.isNone(input)) {
      return respond({
        status: 400,
        body: {
          ok: false,
          error: "invalid_payload",
          message:
            "Expected {text, startedBy: {assistantName, fromComputerName, fromThreadId, …}}.",
        },
      });
    }
    const host = yield* makeHost;
    return respond(yield* host.create(input.value));
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const remoteChatStatusRouteLayer = HttpRouter.add(
  "GET",
  `${REMOTE_CHATS_PATH}/:threadId`,
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const params = yield* HttpRouter.params;
    const host = yield* makeHost;
    return respond(yield* host.status(params["threadId"] ?? ""));
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const startedByRouteLayer = HttpRouter.add(
  "GET",
  STARTED_BY_PATH,
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const host = yield* makeHost;
    return respond(yield* host.startedBy());
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const remoteComputersRouteLayers = [
  remoteChatCreateRouteLayer,
  remoteChatStatusRouteLayer,
  startedByRouteLayer,
] as const;
