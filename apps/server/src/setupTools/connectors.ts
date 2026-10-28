/**
 * Connectors (Google Drive, Gmail & Calendar, Notion, GitHub) as this
 * computer sees them: a thin client over the console's routes, with one of
 * two credentials ({@link connectorCredentialsFrom}):
 *
 * - a cloud computer: its work-machine token `settings.uno.boxToken` on the
 *   machine routes `/api/v1/boxes/{id}/work/connectors…` (onboarding v3
 *   contract, section "Connectors"); the machine's connector permissions
 *   apply there;
 * - a computer without a box (Uno Work on a Mac): the account key the
 *   person pasted (`settings.uno.apiKey`, not a `unollm_` gateway key) on
 *   the account routes `/api/v1/work/connectors…` (fishcode
 *   `feat/connectors-account-key-1028`; decision 16.10 "the console lets a
 *   Mac in by the account key"). An older console answers 404 there:
 *   listed as `console_outdated`.
 *
 * Neither: `sign_in_required` — the person signs in to Uno on this computer.
 *
 * Grants live at the console, per account. The daemon only lists them for
 * the Setup screen (`GET /api/manager/connectors`), starts / removes a grant,
 * and forwards the agents' tool calls (`uno-work` MCP). No OAuth token of a
 * provider ever reaches this machine.
 *
 * Pure (fetch and clock injected) so the whole thing is unit-testable; the
 * Effect service in `ConnectorsService.ts` binds it to the settings.
 *
 * @module setupTools/connectors
 */

/** The console's JSON Schema of a tool's arguments, passed through untouched. */
export type ConnectorInputSchema = Record<string, unknown>;

export interface ConnectorToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ConnectorInputSchema;
}

/** One connector as the console reports it (camelCased). */
export interface ConsoleConnector {
  readonly provider: string;
  readonly name: string;
  readonly description: string;
  readonly available: boolean;
  readonly connected: boolean;
  readonly account: string | null;
  readonly connectedAt: string | null;
  /** The provider refused the grant (expired, revoked): sign in again. */
  readonly needsReconnect: boolean;
  readonly tools: ReadonlyArray<ConnectorToolDescriptor>;
}

/** `GET /api/manager/connectors` — one row per connector. */
export interface ManagerConnectorView {
  readonly provider: string;
  readonly name: string;
  readonly description: string;
  readonly available: boolean;
  readonly connected: boolean;
  readonly account: string | null;
  readonly connectedAt: string | null;
  /** Listed as connected, but the provider refused it: the row says Reconnect. */
  readonly needsReconnect?: boolean;
  readonly toolCount: number;
}

/**
 * Why the list is unavailable:
 * - `sign_in_required` — no machine token and no account key on this
 *   computer (an older daemon said `not_cloud_computer` for the same);
 * - `console_outdated` — the console doesn't serve the account routes yet;
 * - `console_unreachable` — the console didn't answer.
 */
export type ConnectorsUnavailableReason =
  | "sign_in_required"
  | "console_outdated"
  | "console_unreachable";

export interface ManagerConnectorsList {
  readonly available: boolean;
  readonly reason: ConnectorsUnavailableReason | null;
  readonly connectors: ReadonlyArray<ManagerConnectorView>;
}

/** A connected provider's tool, as the `uno-work` MCP server exposes it. */
export interface ConnectorTool extends ConnectorToolDescriptor {
  readonly provider: string;
  readonly providerName: string;
}

export interface ConnectorCallResult {
  readonly content: ReadonlyArray<Record<string, unknown>>;
  readonly isError: boolean;
}

/** A cloud computer: its work-machine token and box id (machine routes). */
export interface MachineCredentials {
  readonly kind?: "machine";
  readonly boxToken: string;
  readonly boxId: number;
}

/** A computer without a box: the person's account key (account routes). */
export interface AccountCredentials {
  readonly kind: "account";
  readonly accountKey: string;
}

export type ConnectorCredentials = MachineCredentials | AccountCredentials;

/** Prefix of the console's gateway-only keys (`unoGatewayKey.ts`): they can't open connectors. */
const GATEWAY_KEY_PREFIX = "unollm_";

/**
 * Which credentials this computer uses for connectors: the machine token
 * first (a cloud computer, the machine's permissions apply), else a real
 * account key (a Mac), else none. A `unollm_` key only buys AI: none.
 */
export function connectorCredentialsFrom(input: {
  readonly boxToken: string | null | undefined;
  readonly boxId: number | null | undefined;
  readonly apiKey: string | null | undefined;
}): ConnectorCredentials | null {
  const boxToken = input.boxToken?.trim() ?? "";
  if (boxToken.length > 0 && typeof input.boxId === "number" && input.boxId > 0) {
    return { kind: "machine", boxToken, boxId: input.boxId };
  }
  const accountKey = input.apiKey?.trim() ?? "";
  if (accountKey.length > 0 && !accountKey.startsWith(GATEWAY_KEY_PREFIX)) {
    return { kind: "account", accountKey };
  }
  return null;
}

const isAccount = (creds: ConnectorCredentials): creds is AccountCredentials =>
  creds.kind === "account";

/** The console path of a connectors route for these credentials. */
export function connectorsRoutePath(creds: ConnectorCredentials, path: string): string {
  return isAccount(creds) ? `/api/v1${path}` : `/api/v1/boxes/${creds.boxId}${path}`;
}

/** Which grant list a cached answer belongs to (never the key itself). */
function credentialsCacheKey(creds: ConnectorCredentials): string {
  return isAccount(creds) ? `account:${creds.accountKey.slice(-8)}` : `machine:${creds.boxId}`;
}

export interface ConnectorsClientDeps {
  /** Machine token + box id, the account key, or null (neither). Read on every call. */
  readonly credentials: () => Promise<ConnectorCredentials | null>;
  readonly baseUrl: () => string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** How long `GET /api/manager/connectors` may serve a cached answer. */
  readonly listTtlMs?: number;
  /** How long the MCP tool list may serve a cached answer. */
  readonly toolsTtlMs?: number;
  readonly requestTimeoutMs?: number;
  readonly callTimeoutMs?: number;
}

/** Why a start / remove / call didn't happen. `status` is what the daemon route answers. */
export class ConnectorsError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ConnectorsError";
    this.status = status;
    this.code = code;
  }
}

/** @deprecated the old name of {@link SIGN_IN_REQUIRED}, still sent by older daemons. */
export const NOT_CLOUD_COMPUTER = "not_cloud_computer";
export const SIGN_IN_REQUIRED = "sign_in_required";

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isConnectorProvider(value: string): boolean {
  return PROVIDER_PATTERN.test(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseTool(raw: unknown): ConnectorToolDescriptor | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const name = str(record["name"]).trim();
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) return null;
  const schema = record["input_schema"] ?? record["inputSchema"];
  return {
    name,
    description: str(record["description"]),
    inputSchema:
      schema !== null && typeof schema === "object" && !Array.isArray(schema)
        ? (schema as ConnectorInputSchema)
        : { type: "object", properties: {} },
  };
}

/** The console's `{connectors:[…]}` (snake_case) → camelCase; junk rows dropped. */
export function parseConsoleConnectors(raw: unknown): ReadonlyArray<ConsoleConnector> {
  const list =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)["connectors"]
      : undefined;
  if (!Array.isArray(list)) return [];
  const out: ConsoleConnector[] = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const provider = str(record["provider"]);
    if (!isConnectorProvider(provider)) continue;
    const tools = Array.isArray(record["tools"])
      ? record["tools"].map(parseTool).filter((tool) => tool !== null)
      : [];
    out.push({
      provider,
      name: str(record["name"]) || provider,
      description: str(record["description"]),
      available: record["available"] === true,
      connected: record["connected"] === true,
      account: strOrNull(record["account"]),
      connectedAt: strOrNull(record["connected_at"]),
      needsReconnect: record["needs_reconnect"] === true,
      tools,
    });
  }
  return out;
}

export function toManagerConnectorView(connector: ConsoleConnector): ManagerConnectorView {
  return {
    provider: connector.provider,
    name: connector.name,
    description: connector.description,
    available: connector.available,
    connected: connector.connected,
    account: connector.account,
    connectedAt: connector.connectedAt,
    needsReconnect: connector.needsReconnect,
    toolCount: connector.tools.length,
  };
}

/** Tools of connected providers only; the first provider wins a name clash. */
export function connectedTools(
  connectors: ReadonlyArray<ConsoleConnector>,
): ReadonlyArray<ConnectorTool> {
  const seen = new Set<string>();
  const tools: ConnectorTool[] = [];
  for (const connector of connectors) {
    if (!connector.connected) continue;
    for (const tool of connector.tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      tools.push({ ...tool, provider: connector.provider, providerName: connector.name });
    }
  }
  return tools;
}

/** The console's `{content, is_error}` → MCP content. */
export function parseCallResult(raw: unknown): ConnectorCallResult {
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const content = Array.isArray(record["content"])
    ? record["content"].filter(
        (block): block is Record<string, unknown> =>
          block !== null && typeof block === "object" && typeof block.type === "string",
      )
    : [];
  return {
    content: content.length > 0 ? content : [{ type: "text", text: "(no output)" }],
    isError: record["is_error"] === true || record["isError"] === true,
  };
}

function consoleErrorCode(body: unknown): string | null {
  if (body === null || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  return strOrNull(record["code"]) ?? strOrNull(record["error"]);
}

export interface ConnectorsClient {
  /** The Setup screen's list. `force` skips the 30 s cache. */
  readonly list: (options?: { readonly force?: boolean }) => Promise<ManagerConnectorsList>;
  readonly start: (provider: string) => Promise<{ readonly authorizeUrl: string }>;
  readonly remove: (provider: string) => Promise<void>;
  /** Connected providers' tools for the `uno-work` MCP server. Never throws. */
  readonly tools: () => Promise<ReadonlyArray<ConnectorTool>>;
  readonly call: (input: {
    readonly provider: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
  }) => Promise<ConnectorCallResult>;
  readonly invalidate: () => void;
}

interface Snapshot {
  readonly at: number;
  /** Whose list it is: a Mac that signs in to another account doesn't see the old one. */
  readonly key: string;
  readonly connectors: ReadonlyArray<ConsoleConnector>;
}

/** The account routes are missing on this console (it predates them). */
class ConsoleOutdated extends Error {}

export function makeConnectorsClient(deps: ConnectorsClientDeps): ConnectorsClient {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const listTtlMs = deps.listTtlMs ?? 30_000;
  const toolsTtlMs = deps.toolsTtlMs ?? 60_000;
  const requestTimeoutMs = deps.requestTimeoutMs ?? 10_000;
  const callTimeoutMs = deps.callTimeoutMs ?? 120_000;

  let snapshot: Snapshot | null = null;
  let inflight: Promise<ReadonlyArray<ConsoleConnector>> | null = null;
  /** Bumped by invalidate(): a fetch that started earlier must not refill the cache. */
  let generation = 0;

  const request = async (
    creds: ConnectorCredentials,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; body: unknown }> => {
    let response: Response;
    try {
      response = await fetchImpl(`${deps.baseUrl()}${connectorsRoutePath(creds, path)}`, {
        method,
        headers: {
          Authorization: `Bearer ${isAccount(creds) ? creds.accountKey : creds.boxToken}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new ConnectorsError(
        502,
        "console_unreachable",
        `Couldn't reach the Uno console: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    const text = await response.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, body: parsed };
  };

  const requireCredentials = async (): Promise<ConnectorCredentials> => {
    const creds = await deps.credentials();
    if (creds === null) {
      throw new ConnectorsError(
        409,
        SIGN_IN_REQUIRED,
        "Sign in to Uno on this computer to use connectors: a cloud computer is signed in already; on your own computer, add your Uno account key in Settings.",
      );
    }
    return creds;
  };

  /** A 404 of an account route: the console predates them (not "unknown connector"). */
  const outdatedConsole = (creds: ConnectorCredentials, status: number) =>
    isAccount(creds) && status === 404;

  const fetchConnectors = async (
    creds: ConnectorCredentials,
  ): Promise<ReadonlyArray<ConsoleConnector>> => {
    if (inflight) return inflight;
    const startedAt = generation;
    const key = credentialsCacheKey(creds);
    inflight = (async () => {
      const reply = await request(creds, "GET", "/work/connectors", undefined, requestTimeoutMs);
      if (outdatedConsole(creds, reply.status)) throw new ConsoleOutdated();
      if (reply.status < 200 || reply.status >= 300) {
        throw new ConnectorsError(
          502,
          "console_error",
          `The Uno console answered ${reply.status} for the connectors list.`,
        );
      }
      const connectors = parseConsoleConnectors(reply.body);
      if (startedAt === generation) snapshot = { at: now(), key, connectors };
      return connectors;
    })();
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  };

  const invalidate = () => {
    generation += 1;
    snapshot = null;
  };

  /** The cached answer for these credentials, while it is fresh. */
  const cachedFor = (creds: ConnectorCredentials, ttlMs: number) => {
    const cached = snapshot;
    return cached !== null && cached.key === credentialsCacheKey(creds) && now() - cached.at < ttlMs
      ? cached
      : null;
  };

  const list: ConnectorsClient["list"] = async (options) => {
    const creds = await deps.credentials();
    if (creds === null) return { available: false, reason: SIGN_IN_REQUIRED, connectors: [] };
    const cached = options?.force ? null : cachedFor(creds, listTtlMs);
    let outdated = false;
    const connectors =
      cached?.connectors ??
      (await fetchConnectors(creds).catch((cause: unknown) => {
        outdated = cause instanceof ConsoleOutdated;
        return null;
      }));
    if (connectors === null) {
      return {
        available: false,
        reason: outdated ? "console_outdated" : "console_unreachable",
        connectors: [],
      };
    }
    return { available: true, reason: null, connectors: connectors.map(toManagerConnectorView) };
  };

  const tools: ConnectorsClient["tools"] = async () => {
    const creds = await deps.credentials().catch(() => null);
    if (creds === null) return [];
    const fresh = cachedFor(creds, toolsTtlMs);
    if (fresh !== null) return connectedTools(fresh.connectors);
    const fetched = await fetchConnectors(creds).catch(() => null);
    // The console blinked: keep offering what we knew (for these credentials)
    // rather than dropping tools mid-task.
    const stale = snapshot?.key === credentialsCacheKey(creds) ? snapshot.connectors : [];
    return connectedTools(fetched ?? stale);
  };

  const start: ConnectorsClient["start"] = async (provider) => {
    const creds = await requireCredentials();
    const reply = await request(
      creds,
      "POST",
      `/work/connectors/${encodeURIComponent(provider)}/start`,
      {},
      requestTimeoutMs,
    );
    invalidate();
    if (outdatedConsole(creds, reply.status)) {
      throw new ConnectorsError(
        503,
        "console_outdated",
        "Connecting apps from this computer needs a newer Uno console. Connect them from a cloud computer for now.",
      );
    }
    if (reply.status === 503) {
      throw new ConnectorsError(
        503,
        "connector_not_configured",
        "This connector isn't set up on the Uno console yet.",
      );
    }
    if (reply.status === 404) {
      throw new ConnectorsError(404, "unknown_connector", `Unknown connector: ${provider}.`);
    }
    if (reply.status < 200 || reply.status >= 300) {
      throw new ConnectorsError(
        502,
        consoleErrorCode(reply.body) ?? "console_error",
        `The Uno console answered ${reply.status}.`,
      );
    }
    const authorizeUrl = str((reply.body as Record<string, unknown> | null)?.["authorize_url"]);
    if (!/^https?:\/\//.test(authorizeUrl)) {
      throw new ConnectorsError(502, "console_error", "The console didn't return a sign-in link.");
    }
    return { authorizeUrl };
  };

  const remove: ConnectorsClient["remove"] = async (provider) => {
    const creds = await requireCredentials();
    const reply = await request(
      creds,
      "DELETE",
      `/work/connectors/${encodeURIComponent(provider)}`,
      undefined,
      requestTimeoutMs,
    );
    invalidate();
    // Already gone is what the person wanted.
    if (reply.status === 404) return;
    if (reply.status < 200 || reply.status >= 300) {
      throw new ConnectorsError(
        502,
        consoleErrorCode(reply.body) ?? "console_error",
        `The Uno console answered ${reply.status}.`,
      );
    }
  };

  const call: ConnectorsClient["call"] = async (input) => {
    const creds = await requireCredentials();
    const reply = await request(
      creds,
      "POST",
      `/work/connectors/${encodeURIComponent(input.provider)}/call`,
      { tool: input.tool, arguments: input.arguments },
      callTimeoutMs,
    );
    if (reply.status >= 200 && reply.status < 300) return parseCallResult(reply.body);
    if (outdatedConsole(creds, reply.status)) {
      return {
        content: [
          {
            type: "text",
            text: `The ${input.provider} connector can't be used from this computer yet: the Uno console needs an update. Use it from a cloud computer of the account for now.`,
          },
        ],
        isError: true,
      };
    }
    // The grant was revoked elsewhere: the next tools/list should know.
    if (reply.status === 401 || reply.status === 403 || reply.status === 404) invalidate();
    const detail =
      reply.body !== null && typeof reply.body === "object"
        ? (strOrNull((reply.body as Record<string, unknown>)["message"]) ??
          strOrNull((reply.body as Record<string, unknown>)["error"]))
        : typeof reply.body === "string" && reply.body.length > 0
          ? reply.body.slice(0, 300)
          : null;
    return {
      content: [
        {
          type: "text",
          text: `The ${input.provider} connector failed (${reply.status})${detail ? `: ${detail}` : "."}${
            reply.status === 401 || reply.status === 403 || reply.status === 404
              ? " It may have been disconnected: ask the person to reconnect it in Setup, Connect your tools."
              : ""
          }`,
        },
      ],
      isError: true,
    };
  };

  return { list, start, remove, tools, call, invalidate };
}
