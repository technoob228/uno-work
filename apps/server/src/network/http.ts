/**
 * HTTP surface of Network (owner sessions only, like the other
 * `/api/manager/*` routes):
 *
 * - `GET  /api/manager/network`        → NetworkState
 * - `POST /api/manager/network`        NetworkChangeInput → NetworkState
 * - `POST /api/manager/network/check`  NetworkCheckInput → NetworkProxyCheck
 *
 * The proxy's password travels only inbound; no answer carries it.
 */
import { NetworkChangeInput, NetworkCheckInput } from "@t3tools/contracts";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthError } from "../auth/Services/ServerAuth.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { authenticateOwnerSession, respondToAuthError } from "../manager/http.ts";
import { type NetworkComputerInfo, NetworkService } from "./NetworkService.ts";

const json = (body: unknown, status = 200) =>
  HttpServerResponse.setHeader(
    HttpServerResponse.jsonUnsafe(body, { status }),
    "Cache-Control",
    "no-store",
  );

const thisComputer = Effect.gen(function* () {
  const environment = yield* ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  return {
    id: String(descriptor.environmentId),
    name: descriptor.label,
    // A Uno box or a server: the whole computer is Uno Work's.
    kind: descriptor.machineKind === "computer" ? "desktop" : "cloud",
  } satisfies NetworkComputerInfo;
});

/** `{error}`: the web client shows it as is ("Enter the proxy's host name or IP."). */
const inputError = (message: string) => json({ error: message }, 400);

export const networkStateRouteLayer = HttpRouter.add(
  "GET",
  "/api/manager/network",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const network = yield* NetworkService;
    return json(yield* network.state(yield* thisComputer));
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const networkChangeRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/network",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const network = yield* NetworkService;
    const input = yield* HttpServerRequest.schemaBodyJson(NetworkChangeInput).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid Network change.", status: 400 })),
    );
    return yield* network.change(input, yield* thisComputer).pipe(
      Effect.map((state) => json(state)),
      Effect.catch((error) => Effect.succeed(inputError(error.message))),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const networkCheckRouteLayer = HttpRouter.add(
  "POST",
  "/api/manager/network/check",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const network = yield* NetworkService;
    const input = yield* HttpServerRequest.schemaBodyJson(NetworkCheckInput).pipe(
      Effect.mapError(() => new AuthError({ message: "Invalid proxy.", status: 400 })),
    );
    return yield* network.check(input).pipe(
      Effect.map((check) => json(check)),
      Effect.catch((error) => Effect.succeed(inputError(error.message))),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const networkRouteLayers = [
  networkStateRouteLayer,
  networkChangeRouteLayer,
  networkCheckRouteLayer,
] as const;
