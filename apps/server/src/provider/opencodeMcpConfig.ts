/**
 * Project-level `.mcp.json` → opencode `mcp` config.
 *
 * opencode (и наш форк uno-code) читает MCP-серверы только из своего конфига
 * (`mcp: { name: { type: "local" | "remote", ... } }`), а `.mcp.json` из cwd
 * (формат Claude Code) игнорирует. Этот файл пишет бутстрап воркспейса
 * ассистента — в нём сервер `uno-manager` (create_thread / send_turn / ...).
 * Без конвертации диспетчер на OpenCode/Uno остаётся без своих тулов.
 *
 * Схема — `packages/opencode/src/config/mcp.ts` в uno-code:
 *   local:  { type: "local",  command: string[], environment?: Record<string,string> }
 *   remote: { type: "remote", url: string,        headers?: Record<string,string> }
 *
 * @module opencodeMcpConfig
 */
import * as nodePath from "node:path";

import { Effect, FileSystem } from "effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import { parseMcpJsonToAcpServers } from "./acp/HermesAcpSupport.ts";

export interface OpenCodeLocalMcpServer {
  readonly type: "local";
  readonly command: ReadonlyArray<string>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly enabled: true;
}

export interface OpenCodeRemoteMcpServer {
  readonly type: "remote";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly enabled: true;
}

export type OpenCodeMcpServer = OpenCodeLocalMcpServer | OpenCodeRemoteMcpServer;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pairsToRecord(
  pairs: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): Record<string, string> {
  return Object.fromEntries(pairs.map((pair) => [pair.name, pair.value]));
}

/** ACP `McpServer` (общий промежуточный формат с Hermes) → opencode `mcp`. */
export function acpServersToOpenCodeMcp(
  servers: ReadonlyArray<EffectAcpSchema.McpServer>,
): Record<string, OpenCodeMcpServer> {
  const mcp: Record<string, OpenCodeMcpServer> = {};
  for (const server of servers) {
    if ("url" in server) {
      // opencode `remote` сам пробует Streamable HTTP, затем SSE — отдельного
      // типа под `sse` нет.
      mcp[server.name] = {
        type: "remote",
        url: server.url,
        ...(server.headers.length > 0 ? { headers: pairsToRecord(server.headers) } : {}),
        enabled: true,
      };
    } else {
      mcp[server.name] = {
        type: "local",
        command: [server.command, ...server.args],
        ...(server.env.length > 0 ? { environment: pairsToRecord(server.env) } : {}),
        enabled: true,
      };
    }
  }
  return mcp;
}

/** Сырой `.mcp.json` → opencode `mcp`. Невалидный/пустой файл → `{}`. */
export function parseMcpJsonToOpenCodeMcp(raw: string): Record<string, OpenCodeMcpServer> {
  return acpServersToOpenCodeMcp(parseMcpJsonToAcpServers(raw));
}

/**
 * Подмешивает `mcp` в существующий `OPENCODE_CONFIG_CONTENT`, сохраняя всё
 * остальное (provider/instructions/agent от драйверов, уже заданные `mcp`,
 * например `uno-search`). Серверы из `.mcp.json` проекта перекрывают
 * одноимённые — они свежее (токен uno-manager ротируется вместе с файлом).
 *
 * Если существующее содержимое не парсится как JSON-объект — возвращаем его
 * как есть: ломать чужой конфиг ради MCP хуже, чем остаться без MCP.
 */
export function mergeMcpIntoOpenCodeConfigContent(
  existing: string | undefined,
  mcp: Readonly<Record<string, OpenCodeMcpServer>>,
): string | undefined {
  if (Object.keys(mcp).length === 0) return existing;

  let base: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };
  if (existing !== undefined && existing.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      return existing;
    }
    if (!isRecord(parsed)) return existing;
    base = parsed;
  }

  const existingMcp = isRecord(base.mcp) ? base.mcp : {};
  return JSON.stringify({ ...base, mcp: { ...existingMcp, ...mcp } });
}

/**
 * Читает `<cwd>/.mcp.json` и возвращает оверлей env с `OPENCODE_CONFIG_CONTENT`,
 * в который подмешаны его серверы. Нет файла / нет серверов → `{}`.
 * В лог — только имена серверов: заголовки/env содержат токены.
 */
export const projectMcpConfigOverlay = Effect.fn("projectMcpConfigOverlay")(function* (input: {
  readonly cwd: string;
  readonly existingConfigContent: string | undefined;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem
    .readFileString(nodePath.join(input.cwd, ".mcp.json"))
    .pipe(Effect.orElseSucceed(() => ""));
  if (!raw) return {} as Record<string, string>;

  const mcp = parseMcpJsonToOpenCodeMcp(raw);
  const merged = mergeMcpIntoOpenCodeConfigContent(input.existingConfigContent, mcp);
  if (merged === undefined || merged === input.existingConfigContent) {
    return {} as Record<string, string>;
  }
  yield* Effect.logInfo("opencode: attached project .mcp.json servers").pipe(
    Effect.annotateLogs({ cwd: input.cwd, servers: Object.keys(mcp).join(",") }),
  );
  return { OPENCODE_CONFIG_CONTENT: merged } as Record<string, string>;
});
