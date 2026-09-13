/**
 * "Use this computer": turn a discovered local daemon into a saved
 * environment without the person copying a pairing link.
 *
 * 1. POST /api/auth/link-request on the daemon (allowed origins only).
 * 2. Poll GET /api/auth/link-request/{id} until the desktop app answers.
 * 3. On approval the daemon hands over an ordinary one-time pairing
 *    credential; the normal `addSavedEnvironment` bootstrap takes it from
 *    there, exactly as if the user had pasted `t3 auth pairing create`.
 *
 * Network access is injected so the state machine is testable with a fake
 * fetch and fake timers.
 */
import type {
  AuthLinkRequestCreateInput,
  AuthLinkRequestCreateResult,
  AuthLinkRequestPollResult,
} from "@t3tools/contracts";

import type { LocalDaemonDescriptor } from "./localDaemonDiscovery";

/**
 * A daemon that answers 404 to the link request predates the feature (desktop
 * builds before 0.0.52) or is not the desktop at all; either way the fix is
 * on that computer, so say so instead of quoting a status code.
 */
export const OUTDATED_DAEMON_MESSAGE =
  "Uno Work on this computer is too old to accept links from the browser. Update it to version 0.0.52 or newer, then try again.";

export const LOCAL_DAEMON_LINK_POLL_INTERVAL_MS = 1_000;
/** Matches the daemon's request TTL, plus a little for the last poll. */
export const LOCAL_DAEMON_LINK_TIMEOUT_MS = 2 * 60_000 + 5_000;

export type LocalDaemonLinkOutcome =
  | { readonly status: "approved"; readonly credential: string }
  | { readonly status: "denied" }
  | { readonly status: "timeout" }
  | { readonly status: "unavailable"; readonly message: string };

export interface RequestLocalDaemonLinkOptions {
  readonly daemon: Pick<LocalDaemonDescriptor, "httpBaseUrl">;
  /** Origin of this page, as the prompt will name it. */
  readonly origin: string;
  /** What the prompt and the paired-client list call this browser. */
  readonly label: string;
  readonly fetch?: typeof fetch;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onPending?: (input: { readonly requestId: string; readonly expiresAt: string }) => void;
}

function endpoint(httpBaseUrl: string, pathname: string): string {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const parsed = (await response.json()) as { readonly error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error;
    }
  } catch {
    // Not JSON.
  }
  return fallback;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", finish);
      resolve();
    }, ms);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** A label like "Chrome on macOS" without a UA parser: good enough for a prompt. */
export function describeBrowserForLink(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "Browser";
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(userAgent)
      ? "macOS"
      : /Android/.test(userAgent)
        ? "Android"
        : /iPhone|iPad/.test(userAgent)
          ? "iOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  return os ? `${browser} on ${os}` : browser;
}

export async function requestLocalDaemonLink(
  options: RequestLocalDaemonLinkOptions,
): Promise<LocalDaemonLinkOutcome> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const pollIntervalMs = options.pollIntervalMs ?? LOCAL_DAEMON_LINK_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? LOCAL_DAEMON_LINK_TIMEOUT_MS;
  const { httpBaseUrl } = options.daemon;
  const signal = options.signal;
  const requestInit = { ...({ targetAddressSpace: "loopback" } as Record<string, unknown>) };

  let created: Response;
  try {
    const payload: AuthLinkRequestCreateInput = { origin: options.origin, label: options.label };
    created = await fetchImpl(endpoint(httpBaseUrl, "/api/auth/link-request"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
      ...requestInit,
    });
  } catch (error) {
    return {
      status: "unavailable",
      message: `Could not reach Uno Work on this computer (${(error as Error).message}).`,
    };
  }
  if (!created.ok) {
    return {
      status: "unavailable",
      // A daemon that knows the endpoint explains itself in the body (e.g. a
      // headless box has nobody to press Allow); an old daemon answers a bare
      // 404 with no body, and the only fix is updating it.
      message: await readErrorMessage(
        created,
        created.status === 404
          ? OUTDATED_DAEMON_MESSAGE
          : `Uno Work refused the request (${created.status}).`,
      ),
    };
  }
  const { requestId, expiresAt } = (await created.json()) as AuthLinkRequestCreateResult;
  options.onPending?.({ requestId, expiresAt: String(expiresAt) });

  const deadline = Date.now() + timeoutMs;
  const pollUrl = endpoint(httpBaseUrl, `/api/auth/link-request/${encodeURIComponent(requestId)}`);
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      break;
    }
    await wait(pollIntervalMs, signal);
    if (signal?.aborted) {
      break;
    }
    let polled: Response;
    try {
      polled = await fetchImpl(pollUrl, {
        method: "GET",
        cache: "no-store",
        ...(signal ? { signal } : {}),
        ...requestInit,
      });
    } catch {
      // A missed poll (daemon restarting, sleep) is not a verdict; keep waiting.
      continue;
    }
    if (polled.status === 404) {
      // The daemon forgot the request (restart); waiting longer cannot help.
      return { status: "timeout" };
    }
    if (!polled.ok) {
      continue;
    }
    const result = (await polled.json()) as AuthLinkRequestPollResult;
    switch (result.status) {
      case "pending":
        continue;
      case "approved":
        if (result.pairing?.credential) {
          return { status: "approved", credential: result.pairing.credential };
        }
        // Approved but the credential went to someone else's poll: treat as spent.
        return { status: "timeout" };
      case "denied":
        return { status: "denied" };
      case "expired":
      case "consumed":
        return { status: "timeout" };
    }
  }
  return { status: "timeout" };
}
