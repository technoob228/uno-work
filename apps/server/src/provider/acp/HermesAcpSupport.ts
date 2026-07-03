/**
 * HermesAcpSupport — spawn/runtime/model-selection helpers for `hermes acp`.
 *
 * Особенности Hermes (сняты пробами, 2026-07-04):
 *
 *   - LLM строго через Uno Gateway: провайдер `openai-api` пинится env-парой
 *     `HERMES_INFERENCE_PROVIDER` + `OPENAI_API_KEY`/`OPENAI_BASE_URL`
 *     (config.yaml ключ Hermes игнорирует, читает только env).
 *   - Изоляция от пользовательского ~/.hermes через `HERMES_HOME`.
 *   - `session/set_model` принимает `provider:model`, НО когда целевой
 *     провайдер совпадает с текущим, hermes прогоняет модель через
 *     detect_provider_for_model и namespaced-id (`anthropic/...`) угоняется
 *     в openrouter (модель есть в его каталоге) — ключ становится невалидным
 *     и все turn'ы падают в 401. Обход: детерминированная пара вызовов —
 *     сначала `openrouter:<model>` (чистая смена провайдера, без detection),
 *     затем `openai-api:<model>` (target != current → detection не
 *     запускается, base_url берётся из env). Проверено живым прогоном.
 *   - Модели НЕ config options (configOptions всегда пуст) — cursor-путь
 *     `setModel`→`set_config_option` не работает, только нативные
 *     `session/set_model` / `session/set_mode` через raw request.
 *   - Режимы — только edit-approval политики: default / accept_edits /
 *     dont_ask.
 *
 * @module HermesAcpSupport
 */
import type { HermesSettings, RuntimeMode } from "@t3tools/contracts";
import { UNO_GATEWAY_BASE_URL } from "@t3tools/contracts";
import { Effect, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

/** Провайдер-неймспейс Hermes для кастомного OpenAI-совместимого эндпоинта. */
export const HERMES_GATEWAY_PROVIDER = "openai-api";
/** Промежуточный провайдер в двойном set_model (см. модульный докблок). */
const HERMES_MODEL_SWITCH_PIVOT_PROVIDER = "openrouter";

export const HERMES_MODE_DEFAULT = "default";
export const HERMES_MODE_ACCEPT_EDITS = "accept_edits";
export const HERMES_MODE_DONT_ASK = "dont_ask";

type HermesAcpRuntimeSettings = Pick<HermesSettings, "binaryPath">;

export interface HermesAcpRuntimeInput
  extends Omit<AcpSessionRuntimeOptions, "authMethodId" | "clientCapabilities" | "spawn"> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface HermesSpawnEnvironmentInput {
  /** Верхнеуровневый `uno.apiKey` из настроек приложения (как у UnoDriver). */
  readonly unoApiKey: string;
  /** Изолированный HERMES_HOME инстанса: `<stateDir>/hermes-home-<instanceId>`. */
  readonly hermesHome: string;
}

/**
 * Env-набор, пинящий Hermes на Uno Gateway и изолирующий его состояние от
 * пользовательского ~/.hermes.
 */
export function buildHermesSpawnEnvironment(
  input: HermesSpawnEnvironmentInput,
): Record<string, string> {
  return {
    HERMES_HOME: input.hermesHome,
    HERMES_INFERENCE_PROVIDER: HERMES_GATEWAY_PROVIDER,
    OPENAI_API_KEY: input.unoApiKey,
    OPENAI_BASE_URL: UNO_GATEWAY_BASE_URL,
  };
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSpawnInput {
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        // Hermes публикует auth-метод с id = активный провайдер; провайдер
        // у нас всегда пинится в openai-api через env.
        authMethodId: HERMES_GATEWAY_PROVIDER,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

/** Срезает опциональный `<provider>:`-префикс до чистого id модели гейтвея. */
export function resolveHermesBaseModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  const colon = trimmed.indexOf(":");
  if (colon > 0 && trimmed.slice(0, colon).match(/^[a-z][a-z0-9-]*$/)) {
    return trimmed.slice(colon + 1).trim() || undefined;
  }
  return trimmed;
}

export interface HermesModelSelectionRuntime {
  readonly request: AcpSessionRuntimeShape["request"];
}

/**
 * Применяет модель через двойной `session/set_model` (см. модульный докблок:
 * прямой вызов `openai-api:<model>` при уже активном openai-api угоняет
 * сессию в openrouter).
 */
export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: HermesModelSelectionRuntime;
  readonly sessionId: string;
  readonly model: string;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  const setModel = (providerNamespace: string) =>
    input.runtime
      .request("session/set_model", {
        sessionId: input.sessionId,
        modelId: `${providerNamespace}:${input.model}`,
      })
      .pipe(Effect.mapError(input.mapError));

  return setModel(HERMES_MODEL_SWITCH_PIVOT_PROVIDER).pipe(
    Effect.andThen(setModel(HERMES_GATEWAY_PROVIDER)),
    Effect.asVoid,
  );
}

/**
 * Маппинг нашего runtimeMode на hermes-режимы (edit-approval политики).
 * `full-access` — bypass permissions → dont_ask; иначе спрашиваем.
 */
export function resolveHermesModeId(runtimeMode: RuntimeMode): string {
  return runtimeMode === "full-access" ? HERMES_MODE_DONT_ASK : HERMES_MODE_DEFAULT;
}

export function setHermesSessionMode<E>(input: {
  readonly runtime: HermesModelSelectionRuntime;
  readonly sessionId: string;
  readonly modeId: string;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  return input.runtime
    .request("session/set_mode", {
      sessionId: input.sessionId,
      modeId: input.modeId,
    })
    .pipe(Effect.mapError(input.mapError), Effect.asVoid);
}

// ── project-level .mcp.json → ACP mcpServers ────────────────────────────

interface McpJsonServerEntry {
  readonly type?: unknown;
  readonly url?: unknown;
  readonly headers?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
  readonly env?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Конвертирует project-level `.mcp.json` (формат Claude Code — его же пишет
 * бутстрап воркспейса ассистента) в ACP `mcpServers` для `session/new`.
 * Hermes сам `.mcp.json` из cwd не читает — проверено по исходникам и пробой.
 */
export function parseMcpJsonToAcpServers(raw: string): ReadonlyArray<EffectAcpSchema.McpServer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    return [];
  }

  const servers: Array<EffectAcpSchema.McpServer> = [];
  for (const [name, entry] of Object.entries(parsed.mcpServers)) {
    if (!isRecord(entry)) continue;
    const candidate = entry as McpJsonServerEntry;

    if (typeof candidate.url === "string" && candidate.url.trim()) {
      const headers = isRecord(candidate.headers)
        ? Object.entries(candidate.headers).flatMap(([headerName, headerValue]) =>
            typeof headerValue === "string" ? [{ name: headerName, value: headerValue }] : [],
          )
        : [];
      servers.push({
        type: candidate.type === "sse" ? ("sse" as const) : ("http" as const),
        name,
        url: candidate.url.trim(),
        headers,
      });
      continue;
    }

    if (typeof candidate.command === "string" && candidate.command.trim()) {
      const args = Array.isArray(candidate.args)
        ? candidate.args.filter((arg): arg is string => typeof arg === "string")
        : [];
      const env = isRecord(candidate.env)
        ? Object.entries(candidate.env).flatMap(([envName, envValue]) =>
            typeof envValue === "string" ? [{ name: envName, value: envValue }] : [],
          )
        : [];
      servers.push({
        name,
        command: candidate.command.trim(),
        args,
        env,
      });
    }
  }
  return servers;
}
