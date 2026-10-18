/**
 * The door to "Your site" (portPreview.ts): a request the console sends with
 * `X-Uno-Port-Preview` is taken before any route — the SPA's catch-all
 * would answer it with Work's own index.html — and only from the owner (the
 * same session cookie / bearer check as every other HTTP route). A refusal
 * carries `X-Uno-Port-Preview-Auth: failed`, so the console can tell our 401
 * from the program's own.
 *
 * A global router middleware, so it sees every method and path and WebSocket
 * upgrades too; it writes to the Node response itself (production runs on
 * Node; under Bun it answers 501).
 */
import * as Http from "node:http";
import type * as Net from "node:net";

import {
  isPreviewablePort,
  PORT_PREVIEW_AUTH_FAILED_HEADER,
  PORT_PREVIEW_HEADER,
  PORT_PREVIEW_PAGE_TOOLS_PATH,
} from "@t3tools/shared/portPreview";
import { Effect, Option } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { resolveAppApiPort } from "./appSdk/appApiPort.ts";
import { ServerAuth } from "./auth/Services/ServerAuth.ts";
import { SessionCredentialService } from "./auth/Services/SessionCredentialService.ts";
import { ServerConfig } from "./config.ts";
import {
  portPreviewPublicHost,
  type PortPreviewTarget,
  relayPortPreviewRequest,
  relayPortPreviewUpgrade,
  servePageToolsScript,
} from "./portPreview.ts";

/** Why a port can't be previewed; null — it can. */
export function portPreviewPortProblem(
  raw: string,
  reserved: { readonly daemonPort: number; readonly appApiPort: number | null },
): string | null {
  const port = /^\d{1,5}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!isPreviewablePort(port)) return "The port must be a number from 1024 to 65535.";
  if (port === reserved.daemonPort || port === reserved.appApiPort) {
    return "This port belongs to Uno Work itself.";
  }
  return null;
}

export function portPreviewAuthFailedResponse(): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.text("Open this page from Uno Work.", {
    status: 401,
    headers: { [PORT_PREVIEW_AUTH_FAILED_HEADER]: "failed", "Cache-Control": "no-store" },
  });
}

function pathOf(url: string | undefined): string {
  const value = url ?? "/";
  const q = value.indexOf("?");
  return q === -1 ? value : value.slice(0, q);
}

function isUpgradeRequest(source: Http.IncomingMessage): boolean {
  return (
    source.headers.upgrade !== undefined &&
    /(^|,)\s*upgrade\s*(,|$)/i.test(source.headers.connection ?? "")
  );
}

/** The Node response behind an effect request (platform-node's ServerRequestImpl). */
function nodeResponseOf(request: HttpServerRequest.HttpServerRequest): Http.ServerResponse | null {
  const candidate = (request as unknown as { readonly resolvedResponse?: unknown })
    .resolvedResponse;
  return candidate instanceof Http.ServerResponse ? candidate : null;
}

/** Written (or the browser left): mark it ended so the router writes nothing more. */
function markEnded(res: Http.ServerResponse): void {
  if (res.writableEnded) return;
  try {
    res.end();
  } catch {
    // destroyed
  }
}

const handlePortPreview = (
  request: HttpServerRequest.HttpServerRequest,
  rawPort: string,
  deps: {
    readonly auth: (typeof ServerAuth)["Service"];
    readonly sessionCookieName: string;
    readonly daemonPort: number;
  },
) =>
  Effect.gen(function* () {
    const session = yield* deps.auth.authenticateHttpRequest(request).pipe(Effect.option);
    if (Option.isNone(session)) return portPreviewAuthFailedResponse();

    const problem = portPreviewPortProblem(rawPort, {
      daemonPort: deps.daemonPort,
      appApiPort: resolveAppApiPort(),
    });
    if (problem) return HttpServerResponse.text(problem, { status: 400 });

    const source = request.source;
    if (!(source instanceof Http.IncomingMessage)) {
      return HttpServerResponse.text("Previews of this computer's ports need the Node runtime.", {
        status: 501,
      });
    }
    const target: PortPreviewTarget = {
      port: Number(rawPort.trim()),
      publicHost: portPreviewPublicHost(source.headers),
      sessionCookieName: deps.sessionCookieName,
    };

    if (isUpgradeRequest(source)) {
      // The upgrade's socket is ours from here; effect's lazy response is
      // only made after the socket closed (then it writes nowhere).
      yield* Effect.promise(() =>
        relayPortPreviewUpgrade(source, source.socket as Net.Socket, Buffer.alloc(0), target),
      );
      return HttpServerResponse.empty({ status: 101 });
    }

    const res = nodeResponseOf(request);
    if (!res) {
      return HttpServerResponse.text("Previews of this computer's ports need the Node runtime.", {
        status: 501,
      });
    }
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      pathOf(source.url) === PORT_PREVIEW_PAGE_TOOLS_PATH
    ) {
      servePageToolsScript(source, res);
    } else {
      yield* Effect.promise(() => relayPortPreviewRequest(source, res, target));
    }
    markEnded(res);
    return HttpServerResponse.empty({ status: res.statusCode || 200 });
  });

/**
 * Outermost of the router's global middleware: provide it after (outside)
 * the CORS layer, so a port's page never gets Work's CORS answers.
 */
export const portPreviewLayer = HttpRouter.middleware(
  Effect.gen(function* () {
    const auth = yield* ServerAuth;
    const sessions = yield* SessionCredentialService;
    const config = yield* ServerConfig;
    const deps = {
      auth,
      sessionCookieName: sessions.cookieName,
      daemonPort: config.port,
    };
    return <E, R>(
      httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
    ): Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      E,
      R | HttpServerRequest.HttpServerRequest
    > =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const rawPort = request.headers[PORT_PREVIEW_HEADER];
        if (rawPort === undefined) return yield* httpApp;
        return yield* handlePortPreview(request, rawPort, deps);
      });
  }),
  { global: true },
);
