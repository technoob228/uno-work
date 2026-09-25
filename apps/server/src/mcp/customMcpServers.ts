/**
 * MCP servers of an agent session, and how each harness is handed them — the
 * one place for it.
 *
 * One list per session:
 * - the built-in `uno-work` server (Uno Work environment tools, `../unoWork/`),
 *   authenticated with the chat's per-thread bridge token;
 * - the remote servers the owner added by address (setup → "Your own tool",
 *   `settings.mcpServers`), kept current by `CustomMcpServers` below and read
 *   per session, so a tool added during setup is in the very next chat
 *   without rebuilding (and interrupting) running agents.
 *
 * One set of per-harness shapes, so a server shows up in every agent alike:
 * - Claude: the SDK's `mcpServers` query option (`type: "http"`);
 * - Codex: `-c mcp_servers.<name>.*` overrides on `codex app-server` (a token
 *   is read from the session env via `bearer_token_env_var`, never put on the
 *   command line);
 * - OpenCode / Uno: the `mcp` key of `OPENCODE_CONFIG_CONTENT` (`type: "remote"`);
 * - Hermes, Cursor and custom ACP harnesses: `session/new` `mcpServers`
 *   (`type: "http"`), next to the workspace's own `.mcp.json` servers.
 *
 * `preApproved` servers gate approvals in the daemon (the uno-work server asks
 * the person itself), so harness-native prompts for them are switched off —
 * otherwise the person would be asked twice.
 */
import type { UnoMcpServer } from "@t3tools/contracts";
import { Context, Effect, Layer, Option, Stream } from "effect";

import { ServerSettingsService } from "../serverSettings.ts";
import { BROWSER_BRIDGE_TOKEN_ENV, BROWSER_BRIDGE_URL_ENV } from "../browserBridge.ts";
import { UNO_WORK_MCP_PATH, UNO_WORK_MCP_SERVER_NAME } from "../unoWork/constants.ts";

/** One MCP server in harness-neutral form. `UnoMcpServer` from settings fits it. */
export interface McpServerEntry {
  readonly name: string;
  readonly url: string;
  readonly enabled?: boolean;
  /** Static request headers (the uno-work per-thread token). */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Env var holding the bearer token. Codex reads the header from it, so the
   * token stays out of the process's command line.
   */
  readonly bearerTokenEnvVar?: string;
  /** The server asks the person itself: harnesses must not prompt for its tools. */
  readonly preApproved?: boolean;
  /** How long one tool call may take (approvals wait for a person). */
  readonly toolTimeoutSec?: number;
}

export function enabledMcpServers<T extends McpServerEntry>(
  servers: ReadonlyArray<T> | undefined,
): ReadonlyArray<T> {
  return (servers ?? []).filter(
    (server) => server.enabled !== false && /^https?:\/\//i.test(server.url.trim()),
  );
}

// ── The owner's servers (settings.mcpServers) ──────────────────────────

export interface CustomMcpServersShape {
  /** Enabled servers, as of the latest settings. Cheap and synchronous. */
  readonly current: () => ReadonlyArray<UnoMcpServer>;
}

export class CustomMcpServers extends Context.Service<CustomMcpServers, CustomMcpServersShape>()(
  "t3/mcp/CustomMcpServers",
) {}

export const CustomMcpServersLive = Layer.effect(
  CustomMcpServers,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const initial = yield* settings.getSettings.pipe(
      Effect.map((value) => value.mcpServers),
      Effect.orElseSucceed((): ReadonlyArray<UnoMcpServer> => []),
    );
    let current = enabledMcpServers(initial);
    yield* settings.streamChanges.pipe(
      Stream.runForEach((next) =>
        Effect.sync(() => {
          current = enabledMcpServers(next.mcpServers);
        }),
      ),
      Effect.forkScoped,
    );
    return { current: () => current } satisfies CustomMcpServersShape;
  }),
);

/**
 * A getter for drivers: the live list when the service is in the runtime,
 * an empty list in tests and in layers built without it.
 */
export const customMcpServersGetter = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(CustomMcpServers);
  return Option.isSome(service) ? service.value.current : (): ReadonlyArray<UnoMcpServer> => [];
});

// ── The built-in uno-work server ───────────────────────────────────────

/** Seconds a harness may wait on one uno-work tool call (approvals wait for a person). */
export const UNO_WORK_MCP_TOOL_TIMEOUT_SEC = 900;

/** The session's uno-work server, from its bridge env; null without a thread token. */
export function unoWorkMcpServer(
  bridgeEnvironment: Readonly<Record<string, string | undefined>> | undefined,
): McpServerEntry | null {
  const baseUrl = bridgeEnvironment?.[BROWSER_BRIDGE_URL_ENV];
  const token = bridgeEnvironment?.[BROWSER_BRIDGE_TOKEN_ENV];
  if (!baseUrl || !token) return null;
  return {
    name: UNO_WORK_MCP_SERVER_NAME,
    url: `${baseUrl.replace(/\/+$/, "")}${UNO_WORK_MCP_PATH}`,
    headers: { Authorization: `Bearer ${token}` },
    bearerTokenEnvVar: BROWSER_BRIDGE_TOKEN_ENV,
    preApproved: true,
    toolTimeoutSec: UNO_WORK_MCP_TOOL_TIMEOUT_SEC,
  };
}

/**
 * Everything a session gets: uno-work (when the session has a thread token)
 * plus the owner's enabled servers. An owner's server can't take the
 * built-in's name.
 */
export function sessionMcpServers(input: {
  readonly bridgeEnvironment: Readonly<Record<string, string | undefined>> | undefined;
  readonly custom: ReadonlyArray<McpServerEntry> | undefined;
}): ReadonlyArray<McpServerEntry> {
  const builtIn = unoWorkMcpServer(input.bridgeEnvironment);
  const custom = enabledMcpServers(input.custom).filter(
    (server) => server.name !== UNO_WORK_MCP_SERVER_NAME,
  );
  return builtIn ? [builtIn, ...custom] : custom;
}

// ── Claude Agent SDK ───────────────────────────────────────────────────

/** Claude Agent SDK `mcpServers` entries. */
export function claudeMcpServers(servers: ReadonlyArray<McpServerEntry>): Record<
  string,
  {
    readonly type: "http";
    readonly url: string;
    readonly headers?: Readonly<Record<string, string>>;
  }
> {
  return Object.fromEntries(
    enabledMcpServers(servers).map((server) => [
      server.name,
      {
        type: "http" as const,
        url: server.url.trim(),
        ...(server.headers ? { headers: server.headers } : {}),
      },
    ]),
  );
}

/** Claude permission rules (`mcp__<server>`) for servers that ask the person themselves. */
export function claudePreApprovedTools(servers: ReadonlyArray<McpServerEntry>): Array<string> {
  return enabledMcpServers(servers)
    .filter((server) => server.preApproved)
    .map((server) => `mcp__${server.name}`);
}

// ── Codex ──────────────────────────────────────────────────────────────

/** TOML basic string: quotes and backslashes escaped, no newlines. */
function tomlString(value: string): string {
  return `"${value.replace(/[\\"]/g, (char) => `\\${char}`).replace(/[\r\n]/g, "")}"`;
}

/** `codex app-server` arguments: `-c` overrides per server. */
export function codexMcpConfigArgs(servers: ReadonlyArray<McpServerEntry>): ReadonlyArray<string> {
  const args: Array<string> = [];
  for (const server of enabledMcpServers(servers)) {
    const key = `mcp_servers.${server.name}`;
    args.push("-c", `${key}.url=${tomlString(server.url.trim())}`);
    if (server.bearerTokenEnvVar) {
      args.push("-c", `${key}.bearer_token_env_var=${tomlString(server.bearerTokenEnvVar)}`);
    }
    if (server.toolTimeoutSec) args.push("-c", `${key}.tool_timeout_sec=${server.toolTimeoutSec}`);
    // "approve" = run without asking; codex rejects unknown values at start.
    if (server.preApproved) args.push("-c", `${key}.default_tools_approval_mode="approve"`);
  }
  return args;
}

// ── OpenCode / built-in Uno ────────────────────────────────────────────

/** OpenCode / Uno `mcp` config entries. */
export function openCodeMcpConfig(servers: ReadonlyArray<McpServerEntry>): Record<
  string,
  {
    readonly type: "remote";
    readonly url: string;
    readonly enabled: true;
    readonly headers?: Readonly<Record<string, string>>;
    readonly timeout?: number;
  }
> {
  return Object.fromEntries(
    enabledMcpServers(servers).map((server) => [
      server.name,
      {
        type: "remote" as const,
        url: server.url.trim(),
        enabled: true as const,
        ...(server.headers ? { headers: server.headers } : {}),
        // opencode's MCP request timeout, in ms.
        ...(server.toolTimeoutSec ? { timeout: server.toolTimeoutSec * 1000 } : {}),
      },
    ]),
  );
}

/**
 * Adds the servers to an `OPENCODE_CONFIG_CONTENT` JSON string, keeping what
 * is already there (instructions, providers, the bundled `uno-search`). An
 * entry already in the config wins over an owner's server with the same name;
 * the built-in uno-work entry always replaces a stale one (its token is per
 * chat). Returns the input unchanged when there is nothing to add or it is
 * not a JSON object.
 */
export function withOpenCodeMcpServers(
  configContent: string | undefined,
  servers: ReadonlyArray<McpServerEntry>,
): string | undefined {
  const extra = openCodeMcpConfig(servers);
  if (Object.keys(extra).length === 0) return configContent;
  let base: Record<string, unknown> = {};
  if (configContent !== undefined && configContent.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(configContent);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return configContent;
      }
      base = parsed as Record<string, unknown>;
    } catch {
      return configContent;
    }
  } else {
    base = { $schema: "https://opencode.ai/config.json" };
  }
  const existing =
    base.mcp !== null && typeof base.mcp === "object" && !Array.isArray(base.mcp)
      ? (base.mcp as Record<string, unknown>)
      : {};
  const { [UNO_WORK_MCP_SERVER_NAME]: builtIn, ...owners } = extra;
  return JSON.stringify({
    ...base,
    mcp: { ...owners, ...existing, ...(builtIn ? { [UNO_WORK_MCP_SERVER_NAME]: builtIn } : {}) },
  });
}

/**
 * A shared uno-code/OpenCode server (one process for every chat) can't carry a
 * per-chat token: a different config means a different process. For it the
 * uno-work entry authenticates with the bridge's shared MCP token instead, and
 * each tool call names its OpenCode session (the session-env plugin adds
 * `UNO_WORK_MCP_SESSION_ARG`), from which the daemon finds the thread.
 * Returns the input unchanged when there is no uno-work entry.
 */
export function withSharedServerUnoWorkMcp(
  configContent: string | undefined,
  sharedMcpToken: string,
): string | undefined {
  if (configContent === undefined) return configContent;
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(configContent);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return configContent;
    }
    config = parsed as Record<string, unknown>;
  } catch {
    return configContent;
  }
  const mcp = config.mcp;
  if (mcp === null || typeof mcp !== "object" || Array.isArray(mcp)) return configContent;
  const entry = (mcp as Record<string, unknown>)[UNO_WORK_MCP_SERVER_NAME];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return configContent;
  return JSON.stringify({
    ...config,
    mcp: {
      ...(mcp as Record<string, unknown>),
      [UNO_WORK_MCP_SERVER_NAME]: {
        ...(entry as Record<string, unknown>),
        headers: { Authorization: `Bearer ${sharedMcpToken}` },
      },
    },
  });
}

/** OpenCode permission key of the uno-work tools (`<server>_<tool>`). */
export const OPENCODE_UNO_WORK_PERMISSION = `${UNO_WORK_MCP_SERVER_NAME}_*`;

// ── ACP agents (Hermes, Cursor, custom harnesses) ──────────────────────

/**
 * ACP `session/new` `mcpServers` entries (`type: "http"`): Hermes, Cursor
 * (advertises `mcpCapabilities.http`) and custom ACP harnesses, next to the
 * workspace's own `.mcp.json` servers.
 */
export function acpMcpServers(servers: ReadonlyArray<McpServerEntry>): ReadonlyArray<{
  readonly type: "http";
  readonly name: string;
  readonly url: string;
  readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}> {
  return enabledMcpServers(servers).map((server) => ({
    type: "http" as const,
    name: server.name,
    url: server.url.trim(),
    headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
  }));
}
