/**
 * `* /_apps/<appId>/<token>/<rest>` — a registered app of this computer
 * through Uno Work's own (https) address. Rules and the pure parts live in
 * `appProxy.ts`; this file is the route and the byte pump.
 *
 * Order of checks: path shape → token (an unknown app looks exactly like a bad
 * token, so app ids can't be probed) → the app may be proxied at all → the
 * page's CORS preflight → forward to 127.0.0.1:<manifest port>.
 *
 * Not supported (yet): WebSocket upgrades through the proxy.
 */
import { Readable } from "node:stream";

import { Clock, Data, Effect, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type { UnoMachineApps } from "@t3tools/contracts";

import { resolveAppApiPort } from "../appSdk/appApiPort.ts";
import {
  SessionCredentialService,
  type SessionCredentialServiceShape,
} from "../auth/Services/SessionCredentialService.ts";
import { ServerConfig } from "../config.ts";
import {
  APP_PROXY_CSP,
  APP_PROXY_KEY_PURPOSE,
  APP_PROXY_PREFIX,
  appProxyPath,
  appProxyPreflightHeaders,
  appProxyRefusal,
  appProxyRequestHeaders,
  appProxyResponseHeaders,
  parseAppProxyPath,
  verifyAppProxyToken,
  withAppProxyPaths,
} from "./appProxy.ts";
import { openAppUpstream } from "./appProxyUpstream.ts";
import { MachineAppsService } from "./MachineAppsService.ts";
import type { ScannedApp } from "./machineAppsScan.ts";

class AppProxyUpstreamError extends Data.TaggedError("AppProxyUpstreamError")<{
  readonly cause: unknown;
}> {}

/** The daemon's own ports: never a proxy target. */
export function appProxyDaemonPorts(webPort: number): ReadonlySet<number> {
  return new Set([webPort, resolveAppApiPort()].filter((port): port is number => port !== null));
}

/**
 * For the UI's RPC: the app list with `proxyPath` on every app the proxy
 * serves. A daemon whose session service can't derive keys (test doubles)
 * returns the list unchanged.
 */
export function makeAppProxyLinker(
  sessions: Pick<SessionCredentialServiceShape, "deriveSecret">,
  webPort: number,
): (list: UnoMachineApps) => Effect.Effect<UnoMachineApps> {
  const daemonPorts = appProxyDaemonPorts(webPort);
  return (list) =>
    Effect.gen(function* () {
      if (!sessions.deriveSecret) return list;
      const secret = yield* sessions.deriveSecret(APP_PROXY_KEY_PURPOSE);
      const nowMs = yield* Clock.currentTimeMillis;
      return withAppProxyPaths(list, { secret, daemonPorts, nowMs });
    });
}

const PAGE_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": APP_PROXY_CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A small page of our own (expired link, app not running) — sandboxed like the app. */
function proxyPage(status: number, title: string, text: string) {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>body{font:14px system-ui,sans-serif;color:#555;margin:16px}@media(prefers-color-scheme:dark){body{color:#aaa}}b{color:inherit}</style><b>${escapeHtml(title)}</b><p>${escapeHtml(text)}</p>`;
  return HttpServerResponse.text(html, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: PAGE_HEADERS,
  });
}

const expired = proxyPage(
  401,
  "This app link has expired",
  "Open the app again from Home in Uno Work.",
);

function splitRequestTarget(target: string): { pathname: string; search: string } | null {
  // Origin-form only: an absolute-form target (`GET http://other/…`) is refused.
  if (!target.startsWith("/")) return null;
  const query = target.indexOf("?");
  return query === -1
    ? { pathname: target, search: "" }
    : { pathname: target.slice(0, query), search: target.slice(query) };
}

const serveAppProxy = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const target = splitRequestTarget(request.url);
  if (target === null) return proxyPage(400, "Bad request", "This address isn't valid.");
  const parsed = parseAppProxyPath(target.pathname, target.search);
  if (parsed.kind === "invalid") {
    return proxyPage(404, "Not found", "This address isn't valid.");
  }
  if (parsed.kind === "add-slash") {
    return HttpServerResponse.empty({
      status: 308,
      headers: { ...PAGE_HEADERS, location: parsed.location },
    });
  }

  const sessions = yield* SessionCredentialService;
  if (!sessions.deriveSecret) return expired;
  const secret = yield* sessions.deriveSecret(APP_PROXY_KEY_PURPOSE);
  const machineApps = yield* MachineAppsService;
  // The background pass keeps this ≤ 20 s old: proxied requests add no scans.
  const apps: ReadonlyArray<ScannedApp> =
    (yield* machineApps.lastScanned) ?? (yield* machineApps.scanned);
  const app = apps.find((candidate) => candidate.id === `manifest:${parsed.appId}`);
  const nowMs = yield* Clock.currentTimeMillis;
  if (
    app === undefined ||
    app.port === null ||
    !verifyAppProxyToken({
      secret,
      appId: parsed.appId,
      port: app.port,
      token: parsed.token,
      nowMs,
    })
  ) {
    return expired;
  }
  const config = yield* ServerConfig;
  const refusal = appProxyRefusal(app, appProxyDaemonPorts(config.port));
  // Belt and braces: whatever the manifest says, never the daemon itself.
  const isDaemon = app.control.kind === "process" && app.control.pid === process.pid;
  if (refusal !== null || isDaemon) {
    return proxyPage(403, `${app.name} can't be opened here`, refusal ?? "Uno Work's own port");
  }

  if (request.method === "OPTIONS" && request.headers["access-control-request-method"]) {
    return HttpServerResponse.empty({
      status: 204,
      headers: appProxyPreflightHeaders(request.headers),
    });
  }

  const port = app.port;
  const prefix = appProxyPath(parsed.appId, parsed.token);
  const forwardedProto = request.headers["x-forwarded-proto"] === "https" ? "https" : "http";
  const headers = appProxyRequestHeaders({
    headers: request.headers,
    port,
    prefix,
    publicHost: request.headers["host"] ?? null,
    publicProto: forwardedProto,
  });
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody
    ? Readable.from(Stream.toAsyncIterable(request.stream), { objectMode: false })
    : null;
  if (hasBody && request.headers["content-length"] !== undefined) {
    headers["content-length"] = request.headers["content-length"];
  }

  const upstream = yield* Effect.tryPromise({
    try: (signal) =>
      openAppUpstream({
        port,
        method: request.method,
        path: parsed.upstreamPath,
        headers,
        body,
        signal,
      }),
    catch: (cause) => new AppProxyUpstreamError({ cause }),
  }).pipe(Effect.catchTag("AppProxyUpstreamError", () => Effect.succeed(null)));
  if (upstream === null) {
    return proxyPage(
      502,
      `${app.name} isn't answering`,
      "Start it on Home in Uno Work, or wait a few seconds and reload.",
    );
  }

  const status = upstream.statusCode ?? 502;
  const responseHeaders = appProxyResponseHeaders({ headers: upstream.headers, port, prefix });
  if (request.method === "HEAD" || status === 204 || status === 304 || status < 200) {
    upstream.resume();
    return HttpServerResponse.empty({ status, headers: responseHeaders });
  }
  return HttpServerResponse.stream(
    Stream.fromAsyncIterable(
      upstream as AsyncIterable<Uint8Array>,
      (cause) => new AppProxyUpstreamError({ cause }),
    ),
    {
      status,
      headers: responseHeaders,
      contentType: responseHeaders["content-type"] ?? "application/octet-stream",
    },
  );
});

export const appProxyRouteLayer = HttpRouter.add("*", `${APP_PROXY_PREFIX}/*`, serveAppProxy);
