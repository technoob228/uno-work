/**
 * Mobile-compat: HTTP-слой совместимости с апстримным T3-клиентом (мобилка
 * из сторов, линия апстрима после a04c09a19 «Use HttpApi for Environment
 * APIs & standardize authn/authz»).
 *
 * Direct-подключение мобилки (LAN/self-hosted, без relay) ходит так:
 *   1. GET  /.well-known/t3/environment    — дескриптор (у нас уже есть;
 *      отсутствие orchestrationProtocolVersion клиент трактует как 1);
 *   2. POST /oauth/token                    — RFC 8693 token-exchange:
 *      pairing credential → bearer access token (DPoP нужен только relay);
 *   3. GET  /api/auth/session               — состояние сессии (+scopes);
 *   4. POST /api/auth/websocket-ticket      — одноразовый тикет для WS;
 *   5. GET  /ws?wsTicket=…                  — RPC-сокет (алиас в ServerAuth);
 *   6. HTTP-снапшоты: GET /api/orchestration/shell,
 *      GET /api/orchestration/threads/:threadId.
 *
 * Здесь — тонкие адаптеры поверх наших ServerAuth/ProjectionSnapshotQuery.
 * Никакой новой логики авторизации: те же credential- и session-механизмы,
 * что у /api/auth/bootstrap/bearer и /api/auth/ws-token.
 */
import { OrchestrationShellSnapshot, ThreadId } from "@t3tools/contracts";
import { DateTime, Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import { respondToAuthError } from "../auth/http.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { KNOWN_SCOPES, scopesForSessionRole } from "./mobileScopes.ts";

/** Литералы RFC 8693, которые шлёт апстримный клиент. */
const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";

const oauthError = (error: string, description: string, status: number) =>
  HttpServerResponse.jsonUnsafe({ error, error_description: description }, { status });

/**
 * POST /oauth/token — обмен pairing credential на bearer session token.
 *
 * Поверх нашего exchangeBootstrapCredentialForBearerSession: subject_token
 * апстрима = наш bootstrap/pairing credential, access_token ответа = наш
 * session token (его же принимает authenticateHttpRequest как Bearer).
 */
export const oauthTokenRouteLayer = HttpRouter.add(
  "POST",
  "/oauth/token",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const rawBody = yield* request.text.pipe(
      Effect.mapError(
        (cause) => new AuthError({ message: "Failed to read request body.", status: 400, cause }),
      ),
    );
    const form = new URLSearchParams(rawBody);

    const grantType = form.get("grant_type");
    if (grantType !== TOKEN_EXCHANGE_GRANT_TYPE) {
      return oauthError(
        "unsupported_grant_type",
        `Only ${TOKEN_EXCHANGE_GRANT_TYPE} is supported.`,
        400,
      );
    }
    const subjectTokenType = form.get("subject_token_type");
    if (subjectTokenType !== null && subjectTokenType !== ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE) {
      return oauthError(
        "invalid_request",
        `Unsupported subject_token_type: ${subjectTokenType}.`,
        400,
      );
    }
    const subjectToken = form.get("subject_token");
    if (!subjectToken || subjectToken.trim().length === 0) {
      return oauthError("invalid_request", "subject_token is required.", 400);
    }
    // DPoP умеет только relay-контур апстрима; direct-клиенты его не шлют.
    // Если вдруг пришёл — честно отказываем, а не молча выдаём Bearer.
    if (request.headers["dpop"] !== undefined) {
      return oauthError(
        "invalid_request",
        "DPoP-bound tokens are not supported by this environment; retry without a DPoP proof.",
        400,
      );
    }

    // Валидация scope ДО обмена: subject_token одноразовый, и отвечать 400
    // после consume значило бы сжечь credential впустую. Здесь режем только
    // неизвестные имена; пересечение с ролью считаем после обмена (роль
    // зашита в grant и известна только из результата).
    const requestedScopeRaw = form.get("scope");
    const requestedScopes =
      requestedScopeRaw && requestedScopeRaw.trim().length > 0
        ? [...new Set(requestedScopeRaw.trim().split(/\s+/))]
        : undefined;
    if (requestedScopes !== undefined) {
      const unknown = requestedScopes.filter((scope) => !KNOWN_SCOPES.has(scope));
      if (unknown.length > 0) {
        return oauthError("invalid_scope", `Unknown scope(s): ${unknown.join(", ")}.`, 400);
      }
    }

    const serverAuth = yield* ServerAuth;
    const clientLabel = form.get("client_label");
    const result = yield* serverAuth.exchangeBootstrapCredentialForBearerSession(
      subjectToken,
      deriveAuthClientMetadata({
        request,
        ...(clientLabel && clientLabel.trim().length > 0 ? { label: clientLabel.trim() } : {}),
      }),
    );

    const expiresInSeconds = Math.max(
      0,
      Math.floor((DateTime.toEpochMillis(result.expiresAt) - Date.now()) / 1000),
    );

    // RFC 6749 §3.3 / RFC 8693 §2.2.1: сервер вправе выдать МЕНЬШЕ
    // запрошенного и обязан указать фактический scope. Отражать запрос
    // as-is нельзя: client-роль, попросившая admin-скоупы, поверила бы
    // ответу и включила в UI функции, падающие 403. Выдаём пересечение
    // «запрошено ∩ положено по роли»; пустое пересечение (просили только
    // чужое) → полный набор роли: сессия уже создана (credential сожжён
    // обменом), честный downgrade с фактическим scope в ответе.
    const grantedScopes = scopesForSessionRole(result.role);
    const granted = new Set(grantedScopes);
    const intersection = requestedScopes?.filter((scope) => granted.has(scope)) ?? [];
    const issuedScopes = intersection.length > 0 ? intersection : grantedScopes;
    return HttpServerResponse.jsonUnsafe(
      {
        access_token: result.sessionToken,
        issued_token_type: ACCESS_TOKEN_TYPE,
        token_type: "Bearer",
        expires_in: expiresInSeconds,
        scope: issuedScopes.join(" "),
      },
      { status: 200, headers: { "cache-control": "no-store", pragma: "no-cache" } },
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

/**
 * POST /api/auth/websocket-ticket — апстримное имя нашего /api/auth/ws-token.
 * Тот же одноразовый токен, но поле ответа называется `ticket`, тело запроса
 * пустое. В query WS-апгрейда клиент передаст его как `wsTicket` (алиас
 * принят в ServerAuth.authenticateWebSocketUpgrade).
 */
export const authWebSocketTicketRouteLayer = HttpRouter.add(
  "POST",
  "/api/auth/websocket-ticket",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const result = yield* serverAuth.issueWebSocketToken(session);
    return HttpServerResponse.jsonUnsafe(
      { ticket: result.token, expiresAt: result.expiresAt },
      { status: 200, headers: { "cache-control": "no-store", pragma: "no-cache" } },
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

const requireAuthenticatedSession = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  return yield* serverAuth.authenticateHttpRequest(request);
});

/**
 * GET /api/orchestration/shell — HTTP-версия стартового снапшота мобилки
 * (проекты + шелл-сводки тредов). Данные — ровно те же, что первый кадр
 * нашего RPC-стрима orchestration.subscribeShell.
 */
export const orchestrationShellRouteLayer = HttpRouter.add(
  "GET",
  "/api/orchestration/shell",
  Effect.gen(function* () {
    yield* requireAuthenticatedSession;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot().pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Failed to load orchestration shell snapshot.",
            status: 500,
            cause,
          }),
      ),
    );
    return HttpServerResponse.jsonUnsafe(snapshot satisfies OrchestrationShellSnapshot, {
      status: 200,
    });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);

/**
 * GET /api/orchestration/threads/:threadId — HTTP-версия детального снапшота
 * треда, {snapshotSequence, thread}. Пагинацию (`page`) апстрим запрашивает
 * только если сервер анонсировал капабилити threadSnapshotPagination — мы не
 * анонсируем, поэтому отдаём тред целиком.
 */
export const orchestrationThreadDetailRouteLayer = HttpRouter.add(
  "GET",
  "/api/orchestration/threads/:threadId",
  Effect.gen(function* () {
    yield* requireAuthenticatedSession;
    const params = yield* HttpRouter.params;
    const threadId = yield* Schema.decodeUnknownEffect(ThreadId)(params["threadId"]).pipe(
      Effect.mapError(
        () => new AuthError({ message: "Invalid thread id.", status: 400 }),
      ),
    );
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const [threadDetail, sequence] = yield* Effect.all([
      projectionSnapshotQuery.getThreadDetailById(threadId),
      projectionSnapshotQuery.getSnapshotSequence(),
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({ message: "Failed to load thread snapshot.", status: 500, cause }),
      ),
    );
    if (Option.isNone(threadDetail)) {
      return HttpServerResponse.jsonUnsafe(
        { error: `Thread ${threadId} was not found.` },
        { status: 404 },
      );
    }
    return HttpServerResponse.jsonUnsafe(
      { snapshotSequence: sequence.snapshotSequence, thread: threadDetail.value },
      { status: 200 },
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);
