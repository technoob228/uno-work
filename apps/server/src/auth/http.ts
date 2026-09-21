import {
  type AuthBearerBootstrapResult,
  AuthBootstrapInput,
  AuthCreatePairingCredentialInput,
  type AuthLinkRequestCreateResult,
  AuthLinkRequestCreateInput,
  AuthLinkRequestDecideInput,
  type AuthLinkRequestDecideResult,
  type AuthLinkRequestPollResult,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  type AuthWebSocketTokenResult,
  type ServerAuthDescriptor,
} from "@t3tools/contracts";
import { DateTime, Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { isAllowedCorsOrigin } from "../corsOrigins.ts";
import { UnoBoxIdentity } from "../unoBoxIdentity.ts";
import { controlPlaneBaseUrl } from "../workspaceRegistry/unoCloudParse.ts";
import { LinkRequestError, LinkRequestService } from "./Services/LinkRequestService.ts";
import {
  scopesForSessionRole,
  toUpstreamSessionMethod,
  translateAuthDescriptorForUpstream,
} from "../compat/mobileScopes.ts";
import { AuthError, ServerAuth } from "./Services/ServerAuth.ts";
import { SessionCredentialService } from "./Services/SessionCredentialService.ts";
import { deriveAuthClientMetadata } from "./utils.ts";

export const respondToAuthError = (error: AuthError) =>
  Effect.gen(function* () {
    if ((error.status ?? 500) >= 500) {
      yield* Effect.logError("auth route failed", {
        message: error.message,
        cause: error.cause,
      });
    }
    return HttpServerResponse.jsonUnsafe(
      {
        error: error.message,
      },
      { status: error.status ?? 500 },
    );
  });

/**
 * A signed-out browser on an Uno box is offered "Sign in with Uno" instead of
 * a pairing-token field: the box id is what the console needs to check
 * ownership and mint the pairing token itself. `serviceOption` keeps the route
 * usable where box identity is not wired (tests, desktop).
 */
export const withUnoSignIn = <S extends { readonly auth: ServerAuthDescriptor }>(session: S) =>
  Effect.gen(function* () {
    const identity = yield* Effect.serviceOption(UnoBoxIdentity);
    if (identity._tag === "None") return session;
    const boxId = yield* identity.value.current;
    if (boxId === null) return session;
    return {
      ...session,
      auth: { ...session.auth, unoSignIn: { consoleUrl: controlPlaneBaseUrl(), boxId } },
    };
  });

export const authSessionRouteLayer = HttpRouter.add(
  "GET",
  "/api/auth/session",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.getSessionState(request);
    // Mobile-compat: апстримный клиент читает из session `scopes` (у нас их
    // нет — роль шире). Добавляем аддитивно, `role` остаётся для нашего веба.
    // Для bearer-запросов (мобилка всегда ходит с Authorization: Bearer, наш
    // веб — с cookie) дополнительно транслируем литералы session-методов в
    // апстримные, иначе их Schema.Literals валит decode целиком.
    const isBearerRequest = request.headers["authorization"]?.startsWith("Bearer ") === true;
    const compatSession = session.authenticated
      ? {
          ...session,
          scopes: scopesForSessionRole(session.role),
          ...(isBearerRequest
            ? {
                auth: translateAuthDescriptorForUpstream(session.auth),
                ...(session.sessionMethod
                  ? { sessionMethod: toUpstreamSessionMethod(session.sessionMethod) }
                  : {}),
              }
            : {}),
        }
      : yield* withUnoSignIn(session);
    return HttpServerResponse.jsonUnsafe(compatSession, { status: 200 });
  }),
);

const PairingCredentialRequestHeaders = Schema.Struct({
  "content-length": Schema.optionalKey(Schema.String),
  "content-type": Schema.optionalKey(Schema.String),
  "transfer-encoding": Schema.optionalKey(Schema.String),
});

function hasRequestBody(headers: typeof PairingCredentialRequestHeaders.Type) {
  const contentLengthHeader = headers["content-length"];
  if (typeof contentLengthHeader === "string") {
    const contentLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(contentLength)) {
      return contentLength > 0;
    }
  }
  return typeof headers["transfer-encoding"] === "string";
}

export const authBootstrapRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/bootstrap",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const sessions = yield* SessionCredentialService;
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthBootstrapInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid bootstrap payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const result = yield* serverAuth.exchangeBootstrapCredential(
      payload.credential,
      deriveAuthClientMetadata({ request }),
    );

    return yield* HttpServerResponse.jsonUnsafe(result.response, { status: 200 }).pipe(
      HttpServerResponse.setCookie(sessions.cookieName, result.sessionToken, {
        expires: DateTime.toDate(result.response.expiresAt),
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        // За TLS-терминирующим прокси (X-Forwarded-Proto: https) кука не должна
        // ходить по plaintext. Локальный http://127.0.0.1 остаётся без Secure —
        // иначе Electron и dev-режим потеряют сессию.
        secure: request.headers["x-forwarded-proto"] === "https",
      }),
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authBearerBootstrapRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/bootstrap/bearer",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthBootstrapInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid bootstrap payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const result = yield* serverAuth.exchangeBootstrapCredentialForBearerSession(
      payload.credential,
      deriveAuthClientMetadata({ request }),
    );
    return HttpServerResponse.jsonUnsafe(result satisfies AuthBearerBootstrapResult, {
      status: 200,
    });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authWebSocketTokenRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/ws-token",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const result = yield* serverAuth.issueWebSocketToken(session);
    return HttpServerResponse.jsonUnsafe(result satisfies AuthWebSocketTokenResult, {
      status: 200,
    });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authPairingCredentialRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/pairing-token",
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    if (session.role !== "owner") {
      return yield* new AuthError({
        message: "Only owner sessions can create pairing credentials.",
        status: 403,
      });
    }
    const headers = yield* HttpServerRequest.schemaHeaders(PairingCredentialRequestHeaders).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid pairing credential request headers.",
            status: 400,
            cause,
          }),
      ),
    );
    const payload = hasRequestBody(headers)
      ? yield* HttpServerRequest.schemaBodyJson(AuthCreatePairingCredentialInput).pipe(
          Effect.mapError(
            (cause) =>
              new AuthError({
                message: "Invalid pairing credential payload.",
                status: 400,
                cause,
              }),
          ),
        )
      : {};
    const result = yield* serverAuth.issuePairingCredential(payload);
    return HttpServerResponse.jsonUnsafe(result, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

const authenticateOwnerSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request);
  if (session.role !== "owner") {
    return yield* new AuthError({
      message: "Only owner sessions can manage network access.",
      status: 403,
    });
  }
  return { serverAuth, session } as const;
});

export const authPairingLinksRouteLayer = HttpRouter.add(
  "GET",
  "/api/auth/pairing-links",
  Effect.gen(function* () {
    const { serverAuth } = yield* authenticateOwnerSession;
    const pairingLinks = yield* serverAuth.listPairingLinks();
    return HttpServerResponse.jsonUnsafe(pairingLinks, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authPairingLinksRevokeRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/pairing-links/revoke",
  Effect.gen(function* () {
    const { serverAuth } = yield* authenticateOwnerSession;
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthRevokePairingLinkInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid revoke pairing link payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const revoked = yield* serverAuth.revokePairingLink(payload.id);
    return HttpServerResponse.jsonUnsafe({ revoked }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authClientsRouteLayer = HttpRouter.add(
  "GET",
  "/api/auth/clients",
  Effect.gen(function* () {
    const { serverAuth, session } = yield* authenticateOwnerSession;
    const clients = yield* serverAuth.listClientSessions(session.sessionId);
    return HttpServerResponse.jsonUnsafe(clients, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

export const authClientsRevokeRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/clients/revoke",
  Effect.gen(function* () {
    const { serverAuth, session } = yield* authenticateOwnerSession;
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthRevokeClientSessionInput).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Invalid revoke client payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const revoked = yield* serverAuth.revokeClientSession(session.sessionId, payload.sessionId);
    return HttpServerResponse.jsonUnsafe({ revoked }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

/* ------------------------------------------------------------------ *
 * Link requests ("Use this computer")
 *
 * Unauthenticated by design on the browser side: the tab has no session on
 * this daemon yet — that is the whole point. What gates it instead:
 * - the `Origin` header must be one the CORS layer already trusts (so a random
 *   site cannot even ask), and it — not the body — is what the prompt shows;
 * - a human must press Allow in the desktop app (owner session) before any
 *   credential exists;
 * - the credential is a normal one-time pairing token with a 2-minute fuse,
 *   handed out once to whoever knows the random request id.
 * ------------------------------------------------------------------ */

const LINK_REQUEST_LABEL_MAX_LENGTH = 120;

const respondToLinkRequestError = (error: LinkRequestError) =>
  Effect.gen(function* () {
    if (error.status >= 500) {
      yield* Effect.logError("link request route failed", {
        message: error.message,
        cause: error.cause,
      });
    }
    return HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status });
  });

const readAllowedRequestOrigin = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const origin = request.headers["origin"];
  if (typeof origin !== "string" || origin.trim().length === 0) {
    return yield* new LinkRequestError({
      message: "Link requests must come from a browser origin.",
      status: 400,
    });
  }
  if (!isAllowedCorsOrigin(origin)) {
    return yield* new LinkRequestError({
      message: "This origin may not ask to use this computer.",
      status: 400,
    });
  }
  return new URL(origin).origin;
});

export const authLinkRequestCreateRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/link-request",
  Effect.gen(function* () {
    const linkRequests = yield* LinkRequestService;
    const origin = yield* readAllowedRequestOrigin;
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthLinkRequestCreateInput).pipe(
      Effect.mapError(
        (cause) =>
          new LinkRequestError({
            message: "Invalid link request payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const pending = yield* linkRequests.create({
      origin,
      label: payload.label.slice(0, LINK_REQUEST_LABEL_MAX_LENGTH),
    });
    return HttpServerResponse.jsonUnsafe(
      {
        requestId: pending.requestId,
        expiresAt: pending.expiresAt,
      } satisfies AuthLinkRequestCreateResult,
      { status: 200 },
    );
  }).pipe(Effect.catchTag("LinkRequestError", (error) => respondToLinkRequestError(error))),
);

export const authLinkRequestPollRouteLayer = HttpRouter.add(
  "GET",
  "/api/auth/link-request/:requestId",
  Effect.gen(function* () {
    const linkRequests = yield* LinkRequestService;
    yield* readAllowedRequestOrigin;
    const params = yield* HttpRouter.params;
    const requestId = params["requestId"]?.trim() ?? "";
    if (requestId.length === 0) {
      return yield* new LinkRequestError({ message: "Unknown link request.", status: 404 });
    }
    const view = yield* linkRequests.poll(requestId);
    return HttpServerResponse.jsonUnsafe(
      {
        requestId: view.id,
        status: view.status,
        expiresAt: DateTime.makeUnsafe(view.expiresAtMs),
        ...(view.pairing
          ? {
              pairing: {
                id: view.pairing.id,
                credential: view.pairing.credential,
                ...(view.pairing.label ? { label: view.pairing.label } : {}),
                expiresAt: DateTime.makeUnsafe(view.pairing.expiresAtMs),
              },
            }
          : {}),
      } satisfies AuthLinkRequestPollResult,
      // The approved poll carries a live credential: never let a cache keep it.
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }).pipe(Effect.catchTag("LinkRequestError", (error) => respondToLinkRequestError(error))),
);

export const authLinkRequestDecideRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/link-request/decide",
  Effect.gen(function* () {
    yield* authenticateOwnerSession;
    const linkRequests = yield* LinkRequestService;
    const payload = yield* HttpServerRequest.schemaBodyJson(AuthLinkRequestDecideInput).pipe(
      Effect.mapError(
        (cause) =>
          new LinkRequestError({
            message: "Invalid link request decision payload.",
            status: 400,
            cause,
          }),
      ),
    );
    const status = yield* linkRequests.decide(payload.requestId, payload.decision);
    return HttpServerResponse.jsonUnsafe(
      { requestId: payload.requestId, status } satisfies AuthLinkRequestDecideResult,
      { status: 200 },
    );
  }).pipe(
    Effect.catchTag("AuthError", (error) => respondToAuthError(error)),
    Effect.catchTag("LinkRequestError", (error) => respondToLinkRequestError(error)),
  ),
);

export const authClientsRevokeOthersRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/clients/revoke-others",
  Effect.gen(function* () {
    const { serverAuth, session } = yield* authenticateOwnerSession;
    const revokedCount = yield* serverAuth.revokeOtherClientSessions(session.sessionId);
    return HttpServerResponse.jsonUnsafe({ revokedCount }, { status: 200 });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);
