/**
 * Environment-targeted HTTP — one place that decides *which daemon* an owner
 * HTTP request reaches, and refuses to guess.
 *
 * The renderer talks to more than one backend. Chat and orchestration already
 * route through a per-environment `WsRpcClient`, but the owner-facing REST
 * routes (`/api/manager/*`, `/api/orchestration/*`) were same-origin only, so
 * they could address exactly one daemon: whichever one serves the page. On a
 * desktop client connected to a remote environment that is the *local* daemon,
 * which is how an assistant's Telegram token could be saved into a database
 * that no one reads.
 *
 * So a target is resolved from an explicit `environmentId` and nothing else:
 *
 *   - `primary` — a same-origin request carrying the session cookie, exactly
 *     as before;
 *   - `saved` — an absolute URL on the environment's own base plus its stored
 *     bearer session.
 *
 * A saved environment with no usable session is an error, never a silent
 * downgrade to primary: writing an assistant's credentials to the wrong
 * machine is worse than failing loudly. Bearer tokens are read at call time
 * from protected persistence and never enter URLs, component state, thrown
 * messages, or logs.
 *
 * @module environments/http/target
 */
import type { EnvironmentId } from "@t3tools/contracts";

import type { HttpFeature } from "@t3tools/contracts";

import {
  httpFeatureForPath,
  knownToLackHttpFeature,
  readEnvironmentDescriptor,
  updateComputerToUseCopy,
} from "../httpFeatureSupport";
import { getPrimaryKnownEnvironment } from "../primary";
import { resolvePrimaryEnvironmentHttpUrl } from "../primary/target";
import { getSavedEnvironmentRecord, readSavedEnvironmentBearerToken } from "../runtime/catalog";

/** Where an owner HTTP request for a given environment should go. */
export type EnvironmentHttpTarget =
  | { readonly kind: "primary" }
  | {
      readonly kind: "saved";
      readonly environmentId: EnvironmentId;
      readonly httpBaseUrl: string;
      readonly bearerToken: string;
    };

/** The request reached the daemon and it answered with a non-2xx status. */
export class EnvironmentHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly environmentId: EnvironmentId,
  ) {
    super(message);
    this.name = "EnvironmentHttpError";
  }
}

/**
 * The computer's Uno Work does not have this route yet (an interface newer
 * than the daemon — "one window"). Status 404 so callers that already treat
 * 404 as "older computer" keep working; the message says what to do.
 */
export class EnvironmentFeatureUnsupportedError extends EnvironmentHttpError {
  constructor(
    readonly feature: HttpFeature,
    environmentId: EnvironmentId,
  ) {
    const descriptor = readEnvironmentDescriptor(environmentId);
    super(
      404,
      updateComputerToUseCopy(descriptor?.label ?? null, descriptor?.serverVersion ?? null),
      environmentId,
    );
    this.name = "EnvironmentFeatureUnsupportedError";
  }
}

export function isEnvironmentFeatureUnsupportedError(
  error: unknown,
): error is EnvironmentFeatureUnsupportedError {
  return error instanceof EnvironmentFeatureUnsupportedError;
}

/**
 * The request was never made: the environment is unknown, or its saved
 * session is missing/expired. Distinct from {@link EnvironmentHttpError} so
 * callers can offer "Reconnect" instead of showing a server error.
 */
export class EnvironmentUnavailableError extends Error {
  constructor(
    readonly environmentId: EnvironmentId,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EnvironmentUnavailableError";
  }
}

export function isEnvironmentHttpError(error: unknown): error is EnvironmentHttpError {
  return error instanceof EnvironmentHttpError;
}

export function isEnvironmentUnavailableError(
  error: unknown,
): error is EnvironmentUnavailableError {
  return error instanceof EnvironmentUnavailableError;
}

/** True when this id is the environment serving the renderer. */
export function isPrimaryEnvironmentId(environmentId: EnvironmentId): boolean {
  return getPrimaryKnownEnvironment()?.environmentId === environmentId;
}

/**
 * Resolve the daemon an `environmentId` addresses. Throws
 * {@link EnvironmentUnavailableError} rather than falling back to primary.
 */
export async function resolveEnvironmentHttpTarget(
  environmentId: EnvironmentId,
): Promise<EnvironmentHttpTarget> {
  if (isPrimaryEnvironmentId(environmentId)) {
    return { kind: "primary" };
  }

  const record = getSavedEnvironmentRecord(environmentId);
  if (!record) {
    throw new EnvironmentUnavailableError(
      environmentId,
      "This environment is not saved on this device.",
    );
  }

  const bearerToken = await readSavedEnvironmentBearerToken(environmentId);
  if (!bearerToken) {
    throw new EnvironmentUnavailableError(
      environmentId,
      `Reconnect ${record.label} before changing its settings.`,
    );
  }

  return {
    kind: "saved",
    environmentId,
    httpBaseUrl: record.httpBaseUrl,
    bearerToken,
  };
}

export interface EnvironmentRequest {
  readonly environmentId: EnvironmentId;
  readonly pathname: string;
  readonly searchParams?: Record<string, string>;
  readonly method?: "GET" | "POST" | "DELETE";
  readonly body?: unknown;
}

/**
 * Issue an owner HTTP request against exactly one environment and decode its
 * JSON response.
 */
export async function environmentFetchJson<T>(request: EnvironmentRequest): Promise<T> {
  const response = await environmentFetchResponse(request);
  return (await response.json()) as T;
}

/**
 * Same routing as {@link environmentFetchJson}, but hands back the raw
 * response (file bytes, streams). Non-2xx still throws.
 */
export async function environmentFetchResponse(request: EnvironmentRequest): Promise<Response> {
  // A route newer than the computer: don't call it when the daemon is known
  // to lack it, and read "no such route" answers as "update this computer".
  const feature = httpFeatureForPath(request.pathname);
  if (feature && knownToLackHttpFeature(request.environmentId, feature)) {
    throw new EnvironmentFeatureUnsupportedError(feature, request.environmentId);
  }
  const target = await resolveEnvironmentHttpTarget(request.environmentId);
  const response = await sendRequest(target, request);
  if (feature && isMissingRouteResponse(response)) {
    throw new EnvironmentFeatureUnsupportedError(feature, request.environmentId);
  }
  if (!response.ok) {
    throw new EnvironmentHttpError(
      response.status,
      await readErrorMessage(response),
      request.environmentId,
    );
  }
  return response;
}

/**
 * How a daemon without the route answers: 404 without our JSON error body
 * (POST), or its own index.html for a GET under /api (the static fallback).
 * Our routes answer JSON, so a JSON 404 ("no such assistant") stays a 404.
 */
export function isMissingRouteResponse(
  response: Pick<Response, "ok" | "status" | "headers">,
): boolean {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) return false;
  if (response.status === 404) return true;
  return response.ok && contentType.includes("text/html");
}

async function sendRequest(
  target: EnvironmentHttpTarget,
  request: EnvironmentRequest,
): Promise<Response> {
  const method = request.method ?? "GET";
  const headers: Record<string, string> = {};
  if (request.body !== undefined) headers["content-type"] = "application/json";

  const init: RequestInit = {
    method,
    headers,
    ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
  };

  if (target.kind === "primary") {
    // Same-origin with the session cookie — the dev server proxies this to
    // the desktop backend, so the URL has to go through the primary resolver
    // rather than being built from the environment record.
    const requestUrl = resolvePrimaryEnvironmentHttpUrl(request.pathname, request.searchParams);
    return await fetchOrThrow(requestUrl, { ...init, credentials: "include" }, request);
  }

  const url = new URL(target.httpBaseUrl);
  url.pathname = request.pathname;
  url.search = request.searchParams ? new URLSearchParams(request.searchParams).toString() : "";
  url.hash = "";
  return await fetchOrThrow(
    url.toString(),
    {
      ...init,
      // The token authenticates us; sending cookies too would let an
      // unrelated same-site session leak into the remote request.
      credentials: "omit",
      headers: { ...headers, authorization: `Bearer ${target.bearerToken}` },
    },
    request,
  );
}

async function fetchOrThrow(
  requestUrl: string,
  init: RequestInit,
  request: EnvironmentRequest,
): Promise<Response> {
  try {
    return await fetch(requestUrl, init);
  } catch (error) {
    throw new EnvironmentUnavailableError(
      request.environmentId,
      `Could not reach ${request.pathname} on this environment.`,
      { cause: error },
    );
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (text.length === 0) return `Request failed with status ${response.status}.`;
  try {
    const parsed = JSON.parse(text) as { readonly error?: string };
    if (typeof parsed.error === "string" && parsed.error.length > 0) return parsed.error;
  } catch {
    // Non-JSON body — fall through to the raw text.
  }
  return text;
}
