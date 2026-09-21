import type {
  AuthBearerBootstrapResult,
  AuthSessionState,
  AuthWebSocketTokenResult,
  ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";

class RemoteEnvironmentAuthHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RemoteEnvironmentAuthHttpError";
    this.status = status;
  }
}

export function isRemoteEnvironmentAuthHttpError(
  error: unknown,
): error is RemoteEnvironmentAuthHttpError {
  return error instanceof RemoteEnvironmentAuthHttpError;
}

function remoteEndpointUrl(httpBaseUrl: string, pathname: string): string {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function readRemoteAuthErrorMessage(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  const text = await response.text();
  if (!text) {
    return fallbackMessage;
  }

  try {
    const parsed = JSON.parse(text) as { readonly error?: string };
    if (typeof parsed.error === "string" && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    // Fall back to raw text below.
  }

  return text;
}

/**
 * Per-request cap. A box whose public address is not routed yet (fresh box,
 * box waking up) tends to leave the request hanging rather than refusing it;
 * without a cap the UI would spin forever.
 */
export const REMOTE_REQUEST_TIMEOUT_MS = 15_000;

/** Statuses an edge answers while the machine behind it is starting or asleep. */
const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * A request that never got an HTTP answer (network error, CORS-less edge 502,
 * timeout) or got a gateway error. Worth retrying: the machine may just be
 * starting. Carries the raw detail for "Show details".
 */
export class RemoteEnvironmentUnreachableError extends Error {
  readonly requestUrl: string;
  readonly timedOut: boolean;

  constructor(message: string, input: { requestUrl: string; timedOut: boolean; cause?: unknown }) {
    super(message, input.cause !== undefined ? { cause: input.cause } : undefined);
    this.name = "RemoteEnvironmentUnreachableError";
    this.requestUrl = input.requestUrl;
    this.timedOut = input.timedOut;
  }
}

export function isRemoteEnvironmentUnreachableError(
  error: unknown,
): error is RemoteEnvironmentUnreachableError {
  return error instanceof RemoteEnvironmentUnreachableError;
}

/** True for failures that a later attempt may not repeat (see `RemoteEnvironmentUnreachableError`). */
export function isTransientRemoteError(error: unknown): boolean {
  if (isRemoteEnvironmentUnreachableError(error)) return true;
  return isRemoteEnvironmentAuthHttpError(error) && TRANSIENT_HTTP_STATUSES.has(error.status);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchRemoteJsonOnce<T>(input: {
  readonly httpBaseUrl: string;
  readonly pathname: string;
  readonly method?: "GET" | "POST";
  readonly bearerToken?: string;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}): Promise<T> {
  const requestUrl = remoteEndpointUrl(input.httpBaseUrl, input.pathname);
  const timeoutMs = input.timeoutMs ?? REMOTE_REQUEST_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(requestUrl, {
      method: input.method ?? "GET",
      headers: {
        ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(input.bearerToken ? { authorization: `Bearer ${input.bearerToken}` } : {}),
      },
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut =
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new RemoteEnvironmentUnreachableError(
      timedOut
        ? `No answer from ${requestUrl} within ${Math.round(timeoutMs / 1000)} s.`
        : `Failed to fetch remote auth endpoint ${requestUrl} (${(error as Error).message}).`,
      { requestUrl, timedOut, cause: error },
    );
  }

  if (!response.ok) {
    throw new RemoteEnvironmentAuthHttpError(
      await readRemoteAuthErrorMessage(
        response,
        `Remote auth request failed (${response.status}).`,
      ),
      response.status,
    );
  }

  return (await response.json()) as T;
}

/**
 * Read-only requests are retried on transient failures (a couple of short
 * backoffs). Requests with side effects — bootstrapping a pairing credential,
 * minting a ws token — are tried once: the caller decides whether a fresh
 * credential is needed before trying again.
 */
async function fetchRemoteJson<T>(input: {
  readonly httpBaseUrl: string;
  readonly pathname: string;
  readonly method?: "GET" | "POST";
  readonly bearerToken?: string;
  readonly body?: unknown;
  readonly retries?: number;
}): Promise<T> {
  const retries = input.retries ?? ((input.method ?? "GET") === "GET" ? 2 : 0);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchRemoteJsonOnce<T>(input);
    } catch (error) {
      if (attempt >= retries || !isTransientRemoteError(error)) throw error;
      await sleep(1_000 * 2 ** attempt);
    }
  }
}

export async function bootstrapRemoteBearerSession(input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
}): Promise<AuthBearerBootstrapResult> {
  return fetchRemoteJson<AuthBearerBootstrapResult>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/bootstrap/bearer",
    method: "POST",
    body: {
      credential: input.credential,
    },
  });
}

export async function fetchRemoteSessionState(input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Promise<AuthSessionState> {
  return fetchRemoteJson<AuthSessionState>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/session",
    bearerToken: input.bearerToken,
  });
}

export async function fetchRemoteEnvironmentDescriptor(input: {
  readonly httpBaseUrl: string;
}): Promise<ExecutionEnvironmentDescriptor> {
  return fetchRemoteJson<ExecutionEnvironmentDescriptor>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/.well-known/t3/environment",
  });
}

export async function issueRemoteWebSocketToken(input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Promise<AuthWebSocketTokenResult> {
  return fetchRemoteJson<AuthWebSocketTokenResult>({
    httpBaseUrl: input.httpBaseUrl,
    pathname: "/api/auth/ws-token",
    method: "POST",
    bearerToken: input.bearerToken,
  });
}

export async function resolveRemoteWebSocketConnectionUrl(input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}): Promise<string> {
  const issued = await issueRemoteWebSocketToken({
    httpBaseUrl: input.httpBaseUrl,
    bearerToken: input.bearerToken,
  });
  const url = new URL(input.wsBaseUrl, window.location.origin);
  url.searchParams.set("wsToken", issued.token);
  return url.toString();
}
