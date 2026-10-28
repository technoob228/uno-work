/**
 * HTTP surface of "Join my calls" for the Uno Work UI (owner sessions only,
 * like the other `/api/manager/*` routes):
 *
 * - `GET  /api/manager/assistant/calls`                 → AssistantCallsView
 * - `POST /api/manager/assistant/calls/enable` {projectId, allowLowMemory?}
 *        → {ok:true, view} | {ok:false, needs:"google"|"computer"|"memory"|"assistant", message, view}
 * - `POST /api/manager/assistant/calls/disable`         → AssistantCallsView
 * - `PUT  /api/manager/assistant/calls/meetings/:key` {choice:"join"|"skip"|""} → AssistantCallsView
 *
 * @module assistants/assistantCallsHttp
 */
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthError } from "../auth/Services/ServerAuth.ts";
import { authenticateOwnerSession, respondToAuthError } from "../manager/http.ts";
import { AssistantCallsService } from "./AssistantCallsService.ts";

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

const readJson = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.json.pipe(Effect.orElseSucceed(() => null));
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
});

export const assistantCallsViewRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/assistant/calls",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const calls = yield* AssistantCallsService;
    return json(yield* calls.view);
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const assistantCallsEnableRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/calls/enable",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const body = yield* readJson;
    const projectId = typeof body["projectId"] === "string" ? body["projectId"].trim() : "";
    if (!projectId || projectId.length > 200) {
      return yield* new AuthError({ message: "Which assistant? (projectId)", status: 400 });
    }
    const calls = yield* AssistantCallsService;
    return json(
      yield* calls.enable({ projectId, allowLowMemory: body["allowLowMemory"] === true }),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const assistantCallsDisableRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/assistant/calls/disable",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const calls = yield* AssistantCallsService;
    return json(yield* calls.disable);
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const assistantCallsChoiceRouteLayer = HttpRouter.add(
  "PUT",
  "/api/manager/assistant/calls/meetings/:key",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const params = yield* HttpRouter.params;
    const key = params.key ?? "";
    if (!/^[a-f0-9]{6,40}$/.test(key)) {
      return yield* new AuthError({ message: "Unknown meeting.", status: 400 });
    }
    const body = yield* readJson;
    const choice = body["choice"] === "join" || body["choice"] === "skip" ? body["choice"] : "";
    const calls = yield* AssistantCallsService;
    return json(yield* calls.setChoice({ key, choice }));
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const assistantCallsRouteLayers = [
  assistantCallsViewRouteLayer,
  assistantCallsEnableRouteLayer,
  assistantCallsDisableRouteLayer,
  assistantCallsChoiceRouteLayer,
] as const;
