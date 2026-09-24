/**
 * Remote MCP servers the owner added by address (setup → "Your own tool",
 * `settings.mcpServers`). One list, handed to every agent in the shape it
 * understands, so a tool added once shows up in Claude, Codex, OpenCode and
 * Uno alike:
 *
 * - Claude: the SDK's `mcpServers` query option (`type: "http"`);
 * - Codex: `-c mcp_servers.<name>.url=…` overrides on `codex app-server`;
 * - OpenCode / Uno: the `mcp` key of `OPENCODE_CONFIG_CONTENT` (`type: "remote"`).
 *
 * Read per session, not per driver instance: the list lives in a small cache
 * kept current from the settings stream, so a tool added during setup is in
 * the very next chat without rebuilding (and interrupting) running agents.
 * - Hermes / ACP harnesses: ACP `mcpServers` entries (`type: "http"`), next
 *   to the workspace's own `.mcp.json` servers.
 */
import type { UnoMcpServer } from "@t3tools/contracts";
import { Context, Effect, Layer, Option, Stream } from "effect";

import { ServerSettingsService } from "../serverSettings.ts";

export interface CustomMcpServersShape {
  /** Enabled servers, as of the latest settings. Cheap and synchronous. */
  readonly current: () => ReadonlyArray<UnoMcpServer>;
}

export class CustomMcpServers extends Context.Service<CustomMcpServers, CustomMcpServersShape>()(
  "t3/mcp/CustomMcpServers",
) {}

export function enabledMcpServers(
  servers: ReadonlyArray<UnoMcpServer> | undefined,
): ReadonlyArray<UnoMcpServer> {
  return (servers ?? []).filter(
    (server) => server.enabled && /^https?:\/\//i.test(server.url.trim()),
  );
}

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

// ── Per-harness shapes ──────────────────────────────────────────────

/** Claude Agent SDK `mcpServers` entries. */
export function claudeMcpServers(
  servers: ReadonlyArray<UnoMcpServer>,
): Record<string, { readonly type: "http"; readonly url: string }> {
  return Object.fromEntries(
    enabledMcpServers(servers).map((server) => [
      server.name,
      { type: "http" as const, url: server.url.trim() },
    ]),
  );
}

/** ACP `session/new` `mcpServers` entries (Hermes, custom ACP harnesses). */
export function acpMcpServers(servers: ReadonlyArray<UnoMcpServer>): ReadonlyArray<{
  readonly type: "http";
  readonly name: string;
  readonly url: string;
  readonly headers: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}> {
  return enabledMcpServers(servers).map((server) => ({
    type: "http" as const,
    name: server.name,
    url: server.url.trim(),
    headers: [],
  }));
}

/** TOML basic string: quotes and backslashes escaped, no newlines. */
function tomlString(value: string): string {
  return `"${value.replace(/[\\"]/g, (char) => `\\${char}`).replace(/[\r\n]/g, "")}"`;
}

/** `codex app-server` arguments: one `-c` override per server. */
export function codexMcpConfigArgs(servers: ReadonlyArray<UnoMcpServer>): ReadonlyArray<string> {
  return enabledMcpServers(servers).flatMap((server) => [
    "-c",
    `mcp_servers.${server.name}.url=${tomlString(server.url.trim())}`,
  ]);
}

/** OpenCode / Uno `mcp` config entries. */
export function openCodeMcpConfig(
  servers: ReadonlyArray<UnoMcpServer>,
): Record<string, { readonly type: "remote"; readonly url: string; readonly enabled: true }> {
  return Object.fromEntries(
    enabledMcpServers(servers).map((server) => [
      server.name,
      { type: "remote" as const, url: server.url.trim(), enabled: true as const },
    ]),
  );
}

/**
 * Adds the servers to an `OPENCODE_CONFIG_CONTENT` JSON string, keeping what
 * is already there (instructions, providers, the bundled `uno-search`). A
 * built-in entry wins over a user one with the same name. Returns the input
 * unchanged when there is nothing to add or it is not a JSON object.
 */
export function withOpenCodeMcpServers(
  configContent: string | undefined,
  servers: ReadonlyArray<UnoMcpServer>,
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
  return JSON.stringify({ ...base, mcp: { ...extra, ...existing } });
}
