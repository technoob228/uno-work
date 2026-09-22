import Mime from "@effect/platform-node/Mime";
import { Data, Effect, FileSystem, Option, Path } from "effect";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpMiddleware,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
} from "effect/unstable/http";
import { OtlpTracer } from "effect/unstable/observability";

import type { BrowserBridgeRequestContext } from "@t3tools/contracts";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import {
  BROWSER_BRIDGE_COMMAND_PATH,
  BROWSER_BRIDGE_COMMAND_RESULT_PATH,
  BROWSER_BRIDGE_OPEN_PATH,
  BrowserBridge,
  isAllowedBridgeCommand,
  isAllowedBridgeFilePath,
  isAllowedBridgeUrl,
  normalizeBridgeRequestContext,
  normalizeTabScope,
  requireBridgeThread,
} from "./browserBridge.ts";
import { expandHomePath } from "./pathExpansion.ts";
import {
  isValidSecretName,
  isValidSecretTargetFile,
  resolveSecretTargetDirectory,
  SECRET_DESCRIPTION_MAX_LENGTH,
  SECRET_REQUEST_PATH,
  SECRET_RESULT_PATH,
  SECRET_VALUE_MAX_LENGTH,
  upsertEnvContent,
} from "./secretsEnv.ts";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem.ts";
import { executeBridgeCommand, executeBridgeOpenUrl } from "./browserCommandRouter.ts";
import { resolveAttachmentPathById } from "./attachmentStore.ts";
import { resolveStaticDir, ServerConfig } from "./config.ts";
import { OFFICE_ENGINE_ROUTE_PREFIX, resolveOfficeEngineFilePath } from "./officeEngine.ts";
import { getOfficeEngineStatus, startOfficeEngineInstall } from "./officeEngineInstall.ts";
import { isAllowedCorsOrigin, isLoopbackHostname } from "./corsOrigins.ts";
import { HealthCheck } from "./health.ts";
import { decodeOtlpTraceRecords } from "./observability/TraceRecord.ts";
import { BrowserTraceCollector } from "./observability/Services/BrowserTraceCollector.ts";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import { respondToAuthError } from "./auth/http.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";
const FALLBACK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;
const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";

// Which origins may talk to the daemon cross-origin lives in corsOrigins.ts
// (the link-request route needs the same answer). Re-exported for callers
// that historically imported it from here.
export { isLoopbackHostname };

const PRIVATE_NETWORK_REQUEST_HEADER = "access-control-request-private-network";
const PRIVATE_NETWORK_ALLOW_HEADER = "access-control-allow-private-network";

const browserApiCors = HttpMiddleware.cors({
  allowedOrigins: isAllowedCorsOrigin,
  allowedMethods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["authorization", "b3", "traceparent", "content-type"],
  maxAge: 600,
});

// Chrome's Private Network Access: a public page (https://app.uno4.work)
// reaching a loopback server (the desktop daemon) gets a preflight carrying
// `Access-Control-Request-Private-Network: true`, and the browser drops the
// request unless the 204 answers `Access-Control-Allow-Private-Network: true`.
// Only allowed origins get it — the cors middleware already left the
// allow-origin header off for everyone else, and we mirror that gate.
// Typed by hand: effect's `HttpMiddleware` interface answers `Effect<_, any, any>`,
// and that `any` would leak through the global layer into every consumer.
const browserApiCorsWithPrivateNetwork = <E, R>(
  httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest
> =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const response = yield* browserApiCors(httpApp) as Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      E,
      R | HttpServerRequest.HttpServerRequest
    >;
    const origin = request.headers["origin"];
    if (
      request.method === "OPTIONS" &&
      request.headers[PRIVATE_NETWORK_REQUEST_HEADER] === "true" &&
      typeof origin === "string" &&
      isAllowedCorsOrigin(origin)
    ) {
      return HttpServerResponse.setHeader(response, PRIVATE_NETWORK_ALLOW_HEADER, "true");
    }
    return response;
  });

// `global: true` — иначе middleware вешается только на сматченные маршруты, и
// preflight OPTIONS (маршрута под него нет) падает в 404 БЕЗ cors-заголовков:
// браузер режет весь кросс-origin запрос. Глобальный вариант оборачивает роутер
// целиком, а cors-middleware сам отвечает 204 на OPTIONS до роутинга.
export const browserApiCorsLayer = HttpRouter.middleware(browserApiCorsWithPrivateNetwork, {
  global: true,
});

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const requireAuthenticatedRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(request);
});

export const serverEnvironmentRouteLayer = HttpRouter.add(
  "GET",
  "/.well-known/t3/environment",
  Effect.gen(function* () {
    const descriptor = yield* Effect.service(ServerEnvironment).pipe(
      Effect.flatMap((serverEnvironment) => serverEnvironment.getDescriptor),
    );
    return HttpServerResponse.jsonUnsafe(descriptor, { status: 200 });
  }),
);

/**
 * Unauthenticated liveness probe that exercises a real database write.
 * Exposes nothing but ok/error; 503 means the daemon is up but persistence
 * is broken — exactly the half-dead state supervisors must restart.
 */
export const healthRouteLayer = HttpRouter.add(
  "GET",
  "/api/health",
  Effect.gen(function* () {
    const healthCheck = yield* HealthCheck;
    const probeResult = yield* healthCheck.probe.pipe(
      Effect.map(() => null),
      Effect.catch((error) => Effect.succeed(error)),
    );
    if (probeResult === null) {
      return HttpServerResponse.jsonUnsafe({ ok: true, db: "ok" }, { status: 200 });
    }
    yield* Effect.logWarning("health.probe.failed", { cause: probeResult });
    return HttpServerResponse.jsonUnsafe(
      {
        ok: false,
        db: "error",
        message: probeResult instanceof Error ? probeResult.message : String(probeResult),
      },
      { status: 503 },
    );
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("Trace export failed.", { status: 502 })),
        ),
      );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * Контекст запроса к bridge. Тред всегда берётся из токена — подделать его
 * телом запроса нельзя. `cwd` из тела уточняет проект вкладки (модель
 * подставляет `$PWD`), когда токен выдавался без рабочей папки.
 */
function resolveBridgeRequestContext(
  context: BrowserBridgeRequestContext,
  body: unknown,
): BrowserBridgeRequestContext {
  if (context.cwd !== undefined) return context;
  const rawCwd = body && typeof body === "object" ? (body as { cwd?: unknown }).cwd : undefined;
  const fromBody =
    typeof rawCwd === "string" ? normalizeBridgeRequestContext({ cwd: rawCwd }) : undefined;
  return fromBody?.cwd !== undefined ? { ...context, cwd: fromBody.cwd } : context;
}

/** 401/403 моста текстом — тем же способом, каким ручка отвечает на ошибки. */
function bridgeRefusalText(refusal: { readonly status: number; readonly message: string }) {
  return HttpServerResponse.text(refusal.message, { status: refusal.status });
}

/**
 * Endpoint для харнессов: открыть URL во встроенном браузере приложения.
 * Авторизация — bridge-токеном из env подпроцесса (не сессией пользователя):
 * запрос приходит от curl внутри агентской сессии, а не из web-клиента.
 */
export const browserBridgeOpenRouteLayer = HttpRouter.add(
  "POST",
  BROWSER_BRIDGE_OPEN_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const browserBridge = yield* BrowserBridge;
    const thread = requireBridgeThread(browserBridge.authorize(request.headers["authorization"]));
    if (!thread.ok) {
      return bridgeRefusalText(thread);
    }

    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const rawUrl = body && typeof body === "object" ? (body as { url?: unknown }).url : undefined;
    const rawFile =
      body && typeof body === "object" ? (body as { file?: unknown }).file : undefined;
    // Уровень вкладки: чат треда-источника по умолчанию, project/global — когда
    // агент явно просит вкладку, живущую дольше треда.
    const tabScope = normalizeTabScope(
      body && typeof body === "object" ? (body as { scope?: unknown }).scope : undefined,
    );

    if (rawFile !== undefined) {
      if (rawUrl !== undefined) {
        return HttpServerResponse.text('Pass either "url" or "file", not both.', { status: 400 });
      }
      if (!isAllowedBridgeFilePath(rawFile)) {
        return HttpServerResponse.text('Invalid file: expected an absolute path in {"file":...}', {
          status: 400,
        });
      }
      const filePath = expandHomePath(rawFile.trim());
      const fs = yield* FileSystem.FileSystem;
      const stat = yield* fs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(null)));
      if (stat === null || stat.type !== "File") {
        return HttpServerResponse.jsonUnsafe(
          { ok: false, error: `File not found: ${filePath}` },
          { status: 404 },
        );
      }
      const browserBridgeService = yield* BrowserBridge;
      const hasSubscribers = yield* browserBridgeService.hasSubscribers;
      if (!hasSubscribers) {
        return HttpServerResponse.jsonUnsafe(
          { ok: false, error: "No connected app window to show the file in." },
          { status: 502 },
        );
      }
      yield* browserBridgeService.publishOpenFile(
        filePath,
        resolveBridgeRequestContext(thread.context, body),
        tabScope,
      );
      return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 });
    }

    if (!isAllowedBridgeUrl(rawUrl)) {
      return HttpServerResponse.text(
        'Invalid url: expected http(s) URL in {"url":...} or a file path in {"file":...}',
        {
          status: 400,
        },
      );
    }

    const result = yield* executeBridgeOpenUrl(
      rawUrl,
      resolveBridgeRequestContext(thread.context, body),
      tabScope,
    );
    return HttpServerResponse.jsonUnsafe(
      result.ok ? { ok: true } : { ok: false, error: result.error },
      { status: result.ok ? 200 : 502 },
    );
  }),
);

export const browserBridgeCommandRouteLayer = HttpRouter.add(
  "POST",
  BROWSER_BRIDGE_COMMAND_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const browserBridge = yield* BrowserBridge;
    const thread = requireBridgeThread(browserBridge.authorize(request.headers["authorization"]));
    if (!thread.ok) {
      return bridgeRefusalText(thread);
    }

    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const rawInput =
      body && typeof body === "object" && "input" in body
        ? (body as { input?: unknown }).input
        : body;
    if (!isAllowedBridgeCommand(rawInput)) {
      return HttpServerResponse.text("Invalid browser command payload.", { status: 400 });
    }

    const result = yield* executeBridgeCommand(
      rawInput,
      resolveBridgeRequestContext(thread.context, body),
    );
    return HttpServerResponse.jsonUnsafe(result, { status: result.ok ? 200 : 502 });
  }),
);

export const browserBridgeCommandResultRouteLayer = HttpRouter.add(
  "POST",
  BROWSER_BRIDGE_COMMAND_RESULT_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    if (typeof body !== "object" || body === null) {
      return HttpServerResponse.text("Invalid result payload.", { status: 400 });
    }
    const input = body as Record<string, unknown>;
    if (
      typeof input.commandId !== "string" ||
      typeof input.responseToken !== "string" ||
      typeof input.ok !== "boolean" ||
      (input.error !== undefined && typeof input.error !== "string")
    ) {
      return HttpServerResponse.text("Invalid result payload.", { status: 400 });
    }

    const browserBridge = yield* BrowserBridge;
    const accepted = yield* browserBridge.resolveCommandResult({
      commandId: input.commandId,
      responseToken: input.responseToken,
      ok: input.ok,
      ...(input.data !== undefined ? { data: input.data } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
    });
    return HttpServerResponse.jsonUnsafe({ ok: accepted }, { status: accepted ? 200 : 404 });
  }),
);

/**
 * Endpoint для харнессов: запросить у пользователя секрет (API-ключ, пароль)
 * через маскированный input в приложении. Блокируется до ответа пользователя;
 * значение пишется сервером в env-файл проекта и в ответ агенту НЕ попадает.
 * Всегда отвечает 200 с `{ok: boolean}` на обработанный запрос, чтобы агент
 * прочитал причину отказа из тела, а не из кода ошибки curl.
 */
export const secretsRequestRouteLayer = HttpRouter.add(
  "POST",
  SECRET_REQUEST_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const browserBridge = yield* BrowserBridge;
    const thread = requireBridgeThread(browserBridge.authorize(request.headers["authorization"]));
    if (!thread.ok) {
      return bridgeRefusalText(thread);
    }

    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (!isValidSecretName(input.name)) {
      return HttpServerResponse.jsonUnsafe(
        {
          ok: false,
          error: 'Invalid "name": expected an env-style variable name (letters, digits, _).',
        },
        { status: 400 },
      );
    }
    const targetFile = input.targetFile ?? ".env";
    if (!isValidSecretTargetFile(targetFile)) {
      return HttpServerResponse.jsonUnsafe(
        { ok: false, error: 'Invalid "targetFile": expected .env or .env.<suffix>.' },
        { status: 400 },
      );
    }
    if (
      input.description !== undefined &&
      (typeof input.description !== "string" ||
        input.description.length > SECRET_DESCRIPTION_MAX_LENGTH)
    ) {
      return HttpServerResponse.jsonUnsafe(
        { ok: false, error: 'Invalid "description".' },
        { status: 400 },
      );
    }
    if (input.timeoutMs !== undefined && typeof input.timeoutMs !== "number") {
      return HttpServerResponse.jsonUnsafe(
        { ok: false, error: 'Invalid "timeoutMs".' },
        { status: 400 },
      );
    }

    const context = resolveBridgeRequestContext(thread.context, body);
    const cwd = context?.cwd;
    if (!cwd) {
      return HttpServerResponse.jsonUnsafe(
        {
          ok: false,
          error: 'Missing "cwd": pass the project root so the value lands in its env file.',
        },
        { status: 400 },
      );
    }

    const hasSubscribers = yield* browserBridge.hasSubscribers;
    if (!hasSubscribers) {
      return HttpServerResponse.jsonUnsafe(
        { ok: false, error: "No connected app window to ask the user in." },
        { status: 502 },
      );
    }

    // Папку называет токен треда: `.env` пишет сервер, и без этой сверки агент
    // мог положить файл в любой проект на машине.
    const target = resolveSecretTargetDirectory({
      threadCwd: thread.context.cwd,
      requestedCwd: cwd,
    });
    if (!target.ok) {
      return HttpServerResponse.jsonUnsafe(
        {
          ok: false,
          error: "cwd_outside_thread",
          message: `"cwd" вне рабочей папки этого чата (${thread.context.cwd}). Секрет можно просить только в неё.`,
        },
        { status: 403 },
      );
    }

    const outcome = yield* browserBridge.publishSecretRequest(
      {
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        targetFile,
        cwd: target.cwd,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      },
      context,
    );
    return HttpServerResponse.jsonUnsafe(outcome, { status: 200 });
  }),
);

/**
 * Сабмит значения секрета из web-клиента. Авторизация — responseToken из
 * bridge-события (его знает только клиент, получивший событие по
 * аутентифицированному WS). Значение здесь записывается в env-файл и дальше
 * никуда не передаётся.
 */
export const secretsResultRouteLayer = HttpRouter.add(
  "POST",
  SECRET_RESULT_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)));
    if (typeof body !== "object" || body === null) {
      return HttpServerResponse.text("Invalid result payload.", { status: 400 });
    }
    const input = body as Record<string, unknown>;
    if (typeof input.requestId !== "string" || typeof input.responseToken !== "string") {
      return HttpServerResponse.text("Invalid result payload.", { status: 400 });
    }
    const decline = input.decline === true;
    const value = decline
      ? undefined
      : typeof input.value === "string"
        ? input.value.trim()
        : undefined;
    if (!decline && (value === undefined || value.length === 0)) {
      return HttpServerResponse.text("Invalid result payload.", { status: 400 });
    }
    if (value !== undefined && value.length > SECRET_VALUE_MAX_LENGTH) {
      return HttpServerResponse.text("Secret value is too long.", { status: 400 });
    }

    const browserBridge = yield* BrowserBridge;
    const credentials = { requestId: input.requestId, responseToken: input.responseToken };
    const pending = yield* browserBridge.peekSecretRequest(credentials);
    if (!pending) {
      return HttpServerResponse.jsonUnsafe({ ok: false }, { status: 404 });
    }

    if (decline || value === undefined) {
      yield* browserBridge.completeSecretRequest({
        ...credentials,
        outcome: {
          ok: false,
          name: pending.name,
          error: "The user declined to provide this secret.",
        },
      });
      return HttpServerResponse.jsonUnsafe({ ok: true }, { status: 200 });
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const envPath = path.join(expandHomePath(pending.cwd), pending.targetFile);
    const current = yield* fs.readFileString(envPath).pipe(Effect.catch(() => Effect.succeed("")));
    const contents = upsertEnvContent(current, pending.name, value);

    const workspaceFileSystem = yield* WorkspaceFileSystem;
    const written = yield* workspaceFileSystem
      .writeFile({
        cwd: pending.cwd,
        relativePath: pending.targetFile,
        contents,
      })
      .pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
    if (!written) {
      // Запрос остаётся висеть — пользователь может попробовать ещё раз.
      return HttpServerResponse.jsonUnsafe(
        { ok: false, error: `Failed to write ${pending.targetFile}.` },
        { status: 500 },
      );
    }

    yield* browserBridge.completeSecretRequest({
      ...credentials,
      outcome: { ok: true, name: pending.name, file: pending.targetFile },
    });
    return HttpServerResponse.jsonUnsafe(
      { ok: true, name: pending.name, file: pending.targetFile },
      { status: 200 },
    );
  }),
);

export const attachmentsRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rawRelativePath = url.value.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return HttpServerResponse.text("Invalid attachment path", { status: 400 });
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    const filePath = isIdLookup
      ? resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: normalizedRelativePath,
        })
      : resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: normalizedRelativePath,
        });
    if (!filePath) {
      return HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
        status: isIdLookup ? 404 : 400,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const projectFaviconRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-favicon",
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const projectCwd = url.value.searchParams.get("cwd");
    if (!projectCwd) {
      return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    }

    const faviconResolver = yield* ProjectFaviconResolver;
    const faviconFilePath = yield* faviconResolver.resolvePath(projectCwd);
    if (!faviconFilePath) {
      return HttpServerResponse.text(FALLBACK_PROJECT_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
        },
      });
    }

    return yield* HttpServerResponse.file(faviconFilePath, {
      status: 200,
      headers: {
        "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

/**
 * Статический пакет офисного движка (`<baseDir>/office-engine`). Без авторизации:
 * там только публичный AGPL-код редакторов, а файлы пользователя идут через
 * авторизованный WS (filesystem.readFile / projects.writeFile). Отдаём потоком
 * (x2t.wasm ~60 МБ) и с кэшем: движок грузится один раз на браузер.
 */
export const officeEngineRouteLayer = HttpRouter.add(
  "GET",
  `${OFFICE_ENGINE_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const config = yield* ServerConfig;
    const filePath = resolveOfficeEngineFilePath({
      engineDir: config.officeEngineDir,
      requestPathname: url.value.pathname,
    });
    if (!filePath) {
      return HttpServerResponse.text("Invalid office engine path", { status: 400 });
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      contentType: Mime.getType(filePath) ?? "application/octet-stream",
      headers: {
        "Cache-Control": "public, max-age=86400",
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }),
);

/**
 * Office engine install (owner only): `GET` reports status, `POST` starts a
 * background download from Uno's host with a pinned sha256 (officeEngineInstall.ts).
 */
export const officeEngineStatusRouteLayer = HttpRouter.add(
  "GET",
  "/api/office-engine/status",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    yield* serverAuth.authenticateHttpRequest(request);
    const config = yield* ServerConfig;
    const status = yield* Effect.promise(() => getOfficeEngineStatus(config.officeEngineDir));
    return HttpServerResponse.jsonUnsafe(status, { headers: { "Cache-Control": "no-store" } });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const officeEngineInstallRouteLayer = HttpRouter.add(
  "POST",
  "/api/office-engine/install",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    yield* serverAuth.authenticateHttpRequest(request);
    const config = yield* ServerConfig;
    startOfficeEngineInstall(config.officeEngineDir);
    const status = yield* Effect.promise(() => getOfficeEngineStatus(config.officeEngineDir));
    return HttpServerResponse.jsonUnsafe(status, {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir = config.staticDir ?? (config.devUrl ? yield* resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem
      .readFile(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
