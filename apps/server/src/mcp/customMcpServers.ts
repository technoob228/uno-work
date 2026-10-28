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
 *   without rebuilding (and interrupting) running agents. Not in a sandboxed
 *   assistant's chat: they carry the owner's keys and reach (952aedc09d);
 * - the servers the person gave to the assistant the chat belongs to
 *   (`assistantMcpStore.ts`, 28.10) — in its chats only, sandboxed or not;
 *   on a name clash the assistant's wins in its chats. The chat's assistant
 *   is noted at session start by the sandbox policy, which resolves it anyway
 *   (`noteSessionAssistant`), so drivers read the list synchronously.
 *
 * One set of per-harness shapes, so a server shows up in every agent alike:
 * - Claude: the SDK's `mcpServers` query option (`type: "http"`); it lands on
 *   the CLI's command line, so the token and addresses are `${VAR}`
 *   references to the session env, never the values themselves;
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

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { readAssistantMcpServers } from "./assistantMcpStore.ts";
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

/** Which chat a session is for: its assistant's servers, and no owner's in the sandbox. */
export interface McpSessionContext {
  readonly threadId?: string | undefined;
  /** A restricted assistant's chat held by the sandbox: the owner's servers stay out. */
  readonly sandboxed?: boolean | undefined;
}

/**
 * A session's own servers: the owner's (unless sandboxed) and its
 * assistant's; the assistant's win a name clash. Pure.
 */
export function mergeSessionCustomServers(input: {
  readonly owner: ReadonlyArray<UnoMcpServer>;
  readonly assistant: ReadonlyArray<UnoMcpServer>;
  readonly sandboxed: boolean;
}): ReadonlyArray<UnoMcpServer> {
  const assistant = enabledMcpServers(input.assistant).filter(
    (server) => server.name !== UNO_WORK_MCP_SERVER_NAME,
  );
  if (input.sandboxed) return assistant;
  const taken = new Set(assistant.map((server) => server.name));
  return [
    ...enabledMcpServers(input.owner).filter((server) => !taken.has(server.name)),
    ...assistant,
  ];
}

/** Sessions remembered at once (thread → its assistant's servers); oldest dropped first. */
const SESSION_NOTES_LIMIT = 1_000;

export interface CustomMcpServersShape {
  /** The owner's enabled servers, as of the latest settings. Cheap and synchronous. */
  readonly current: () => ReadonlyArray<UnoMcpServer>;
  /** What a session gets: owner's (unless sandboxed) + its assistant's. Synchronous. */
  readonly forSession: (context?: McpSessionContext) => ReadonlyArray<UnoMcpServer>;
  /**
   * Notes whose chat `threadId` is (an assistant's project id, or null for
   * the person's own chat) and loads that assistant's servers. Called before
   * the session starts; never fails (unreadable = no servers of its own).
   */
  readonly noteSessionAssistant: (
    threadId: string,
    assistantProjectId: string | null,
  ) => Effect.Effect<void>;
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
    const config = yield* Effect.serviceOption(ServerConfig);
    const stateDir = Option.isSome(config) ? config.value.stateDir : null;
    const notes = new Map<string, ReadonlyArray<UnoMcpServer>>();
    return {
      current: () => current,
      forSession: (context) =>
        mergeSessionCustomServers({
          owner: current,
          assistant: context?.threadId ? (notes.get(context.threadId) ?? []) : [],
          sandboxed: context?.sandboxed === true,
        }),
      noteSessionAssistant: (threadId, assistantProjectId) =>
        Effect.promise(async () => {
          const servers =
            assistantProjectId === null || stateDir === null
              ? []
              : await readAssistantMcpServers(stateDir, assistantProjectId);
          notes.delete(threadId);
          if (servers.length === 0) return;
          notes.set(threadId, servers);
          if (notes.size > SESSION_NOTES_LIMIT) {
            const oldest = notes.keys().next();
            if (!oldest.done) notes.delete(oldest.value);
          }
        }),
    } satisfies CustomMcpServersShape;
  }),
);

/** A driver's getter: what one session gets (see {@link CustomMcpServersShape.forSession}). */
export type CustomMcpServersGetter = (context?: McpSessionContext) => ReadonlyArray<UnoMcpServer>;

/**
 * A getter for drivers: the live list when the service is in the runtime,
 * an empty list in tests and in layers built without it. Pass the session's
 * thread (and whether it is sandboxed): the owner's servers stay out of a
 * sandboxed chat, its assistant's come in.
 */
export const customMcpServersGetter: Effect.Effect<CustomMcpServersGetter> = Effect.gen(
  function* () {
    const service = yield* Effect.serviceOption(CustomMcpServers);
    return Option.isSome(service)
      ? service.value.forSession
      : (): ReadonlyArray<UnoMcpServer> => [];
  },
);

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

/** Env var carrying the address of the owner's Nth server to Claude (see below). */
export const claudeMcpUrlEnvVar = (index: number): string => `UNO_WORK_MCP_URL_${index}`;

/**
 * Claude Agent SDK `mcpServers` entries plus the env they read.
 *
 * The SDK hands `mcpServers` to the CLI as `--mcp-config <json>`, i.e. on the
 * process's command line, which every user of the machine sees in `ps`. So no
 * secret goes into the JSON itself: Claude Code expands `${VAR}` in the `url`
 * and `headers` of `--mcp-config` from its own environment, and the env of a
 * process is readable only by its user (and root). The uno-work bearer token
 * is already in the session env (`bearerTokenEnvVar`); an owner's server may
 * keep its secret in the address (`…/mcp/s/<key>/…`), so addresses travel as
 * `UNO_WORK_MCP_URL_<n>`. The caller merges `env` into the session env.
 */
export function claudeMcpServers(servers: ReadonlyArray<McpServerEntry>): {
  readonly mcpServers: Record<
    string,
    {
      readonly type: "http";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  >;
  readonly env: Readonly<Record<string, string>>;
} {
  const env: Record<string, string> = {};
  const mcpServers = Object.fromEntries(
    enabledMcpServers(servers).map((server, index) => {
      const urlVar = claudeMcpUrlEnvVar(index);
      env[urlVar] = server.url.trim();
      const headers = server.bearerTokenEnvVar
        ? { Authorization: `Bearer \${${server.bearerTokenEnvVar}}` }
        : server.headers;
      return [
        server.name,
        {
          type: "http" as const,
          url: `\${${urlVar}}`,
          ...(headers ? { headers } : {}),
        },
      ];
    }),
  );
  return { mcpServers, env };
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
 * Per-server tool-call timeouts (`toolTimeoutSec`) by name. ACP entries can't
 * carry them; Hermes gets them through its per-thread config.yaml.
 */
export function mcpToolTimeoutsSec(
  servers: ReadonlyArray<McpServerEntry>,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    enabledMcpServers(servers)
      .filter((server) => server.toolTimeoutSec !== undefined && server.toolTimeoutSec > 0)
      .map((server) => [server.name, server.toolTimeoutSec!]),
  );
}

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
