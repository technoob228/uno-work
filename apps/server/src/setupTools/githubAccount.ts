/**
 * GitHub of the ACCOUNT as this computer sees it: a thin client over the
 * console's `/api/v1/boxes/{id}/work/git/github…` routes, called with the
 * work-machine token.
 *
 * One connection per account — the Uno GitHub App the person installs once
 * (the same one that deploys their sites). This computer only asks whether it
 * is there and, when the person presses "Connect GitHub", for the App's
 * install link. The GitHub token itself never passes through here: git gets
 * it from the credential helper (`gitCredentialHelper.ts`), one repository
 * at a time.
 *
 * Pure (fetch injected) so it is unit-testable; `GithubAccountService.ts`
 * binds it to the settings.
 *
 * @module setupTools/githubAccount
 */
import { ConnectorsError, NOT_CLOUD_COMPUTER, type MachineCredentials } from "./connectors.ts";

export type GithubAccountUnavailableReason =
  /** Not an Uno cloud computer (a person's own laptop): their own git sign-in applies. */
  | "not_cloud_computer"
  | "console_unreachable"
  /** The console predates the route or has no GitHub App. */
  | "not_configured";

/** What this computer may do with GitHub (an assistant's computer may be limited). */
export type GithubAccountPermission = "none" | "read" | "write";

/** `GET /api/manager/github`. */
export interface GithubAccountStatus {
  /** False = "Connect GitHub" can't be offered here; `reason` says why. */
  readonly available: boolean;
  readonly reason: GithubAccountUnavailableReason | null;
  readonly connected: boolean;
  /** GitHub accounts / organisations the Uno App is installed on. */
  readonly accounts: ReadonlyArray<string>;
  readonly permission: GithubAccountPermission;
}

export interface GithubAccountClientDeps {
  readonly credentials: () => Promise<MachineCredentials | null>;
  readonly baseUrl: () => string;
  readonly fetch?: typeof fetch;
  readonly requestTimeoutMs?: number;
}

export interface GithubAccountClient {
  /** Never throws: an unreachable console is an answer. */
  readonly status: () => Promise<GithubAccountStatus>;
  readonly connect: () => Promise<{ readonly authorizeUrl: string }>;
}

const unavailable = (reason: GithubAccountUnavailableReason): GithubAccountStatus => ({
  available: false,
  reason,
  connected: false,
  accounts: [],
  permission: "none",
});

/** The console's `{configured, connected, accounts, permission}` → the daemon's answer. */
export function parseGithubAccountStatus(raw: unknown): GithubAccountStatus {
  if (raw === null || typeof raw !== "object") return unavailable("console_unreachable");
  const record = raw as Record<string, unknown>;
  if (record["configured"] !== true) return unavailable("not_configured");
  const permission = record["permission"];
  const accounts = Array.isArray(record["accounts"])
    ? record["accounts"].filter(
        (login): login is string => typeof login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(login),
      )
    : [];
  return {
    // An assistant the person kept away from GitHub is not offered a way around it.
    available: permission === "read" || permission === "write",
    reason: null,
    connected: record["connected"] === true,
    accounts,
    permission: permission === "read" || permission === "write" ? permission : "none",
  };
}

/** The App's install page lives on github.com and nowhere else. */
export function isGithubInstallUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com";
  } catch {
    return false;
  }
}

export function makeGithubAccountClient(deps: GithubAccountClientDeps): GithubAccountClient {
  const fetchImpl = deps.fetch ?? fetch;
  const requestTimeoutMs = deps.requestTimeoutMs ?? 10_000;

  const request = async (
    creds: MachineCredentials,
    method: "GET" | "POST",
    path: string,
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetchImpl(
      `${deps.baseUrl()}/api/v1/boxes/${creds.boxId}/work/git/github${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${creds.boxToken}`,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
        signal: AbortSignal.timeout(requestTimeoutMs),
      },
    );
    const text = await response.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  };

  const status: GithubAccountClient["status"] = async () => {
    const creds = await deps.credentials().catch(() => null);
    if (creds === null) return unavailable(NOT_CLOUD_COMPUTER);
    try {
      const reply = await request(creds, "GET", "");
      // 404 = a console from before this route: nothing to offer yet.
      if (reply.status === 404) return unavailable("not_configured");
      if (reply.status < 200 || reply.status >= 300) return unavailable("console_unreachable");
      return parseGithubAccountStatus(reply.body);
    } catch {
      return unavailable("console_unreachable");
    }
  };

  const connect: GithubAccountClient["connect"] = async () => {
    const creds = await deps.credentials();
    if (creds === null) {
      throw new ConnectorsError(
        409,
        NOT_CLOUD_COMPUTER,
        "GitHub through your Uno account works on an Uno cloud computer.",
      );
    }
    let reply: { status: number; body: unknown };
    try {
      reply = await request(creds, "POST", "/connect");
    } catch (cause) {
      throw new ConnectorsError(
        502,
        "console_unreachable",
        `Couldn't reach the Uno console: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (reply.status === 503 || reply.status === 404) {
      throw new ConnectorsError(503, "not_configured", "GitHub isn't set up on Uno yet.");
    }
    if (reply.status === 403) {
      throw new ConnectorsError(403, "not_allowed", "GitHub is turned off for this assistant.");
    }
    const record =
      reply.body !== null && typeof reply.body === "object"
        ? (reply.body as Record<string, unknown>)
        : {};
    const authorizeUrl = typeof record["authorize_url"] === "string" ? record["authorize_url"] : "";
    if (reply.status < 200 || reply.status >= 300 || !isGithubInstallUrl(authorizeUrl)) {
      throw new ConnectorsError(502, "console_error", "The console didn't return a GitHub link.");
    }
    return { authorizeUrl };
  };

  return { status, connect };
}
