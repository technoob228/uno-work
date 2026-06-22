import { randomBytes } from "node:crypto";

import type {
  BrowserAutomationCommandInput,
  BrowserAutomationCommandResult,
  BrowserBridgeStreamEvent,
} from "@t3tools/contracts";
import { Context, Deferred, Duration, Effect, Layer, Option, PubSub, Ref, Stream } from "effect";

import { ServerConfig } from "./config.ts";

/**
 * Мост «харнесс → встроенный браузер».
 *
 * Сервер раздаёт подпроцессам харнессов пару env-переменных
 * (`UNO_WORK_BRIDGE_URL` + `UNO_WORK_BRIDGE_TOKEN`). Модель открывает страницу
 * пользователю обычным curl-запросом на `POST /api/browser/open`; сервер
 * пушит событие подписчикам (web-клиентам) через `subscribeBrowserBridge`.
 */

export const BROWSER_BRIDGE_URL_ENV = "UNO_WORK_BRIDGE_URL";
export const BROWSER_BRIDGE_TOKEN_ENV = "UNO_WORK_BRIDGE_TOKEN";
export const BROWSER_BRIDGE_OPEN_PATH = "/api/browser/open";
export const BROWSER_BRIDGE_COMMAND_PATH = "/api/browser/command";
export const BROWSER_BRIDGE_COMMAND_RESULT_PATH = "/api/browser/command/result";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const MAX_SELECTOR_LENGTH = 2_000;
const MAX_TEXT_LENGTH = 16_000;
const MAX_SCRIPT_LENGTH = 32_000;

const ALLOWED_COMMANDS = new Set<BrowserAutomationCommandInput["command"]>([
  "openUrl",
  "state",
  "screenshot",
  "click",
  "clickText",
  "type",
  "press",
  "navigate",
  "reload",
  "back",
  "forward",
  "evaluate",
]);

export function isAllowedBridgeUrl(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > 8192) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isOptionalString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalTimeout(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= MAX_COMMAND_TIMEOUT_MS)
  );
}

export function isAllowedBridgeCommand(
  rawInput: unknown,
): rawInput is BrowserAutomationCommandInput {
  if (typeof rawInput !== "object" || rawInput === null) {
    return false;
  }
  const input = rawInput as Record<string, unknown>;
  if (typeof input.command !== "string" || !ALLOWED_COMMANDS.has(input.command as never)) {
    return false;
  }
  if (!isOptionalString(input.selector, MAX_SELECTOR_LENGTH)) return false;
  if (!isOptionalString(input.text, MAX_TEXT_LENGTH)) return false;
  if (!isOptionalString(input.value, MAX_TEXT_LENGTH)) return false;
  if (!isOptionalString(input.key, 200)) return false;
  if (!isOptionalString(input.script, MAX_SCRIPT_LENGTH)) return false;
  if (!isOptionalFiniteNumber(input.x) || !isOptionalFiniteNumber(input.y)) return false;
  if (!isOptionalTimeout(input.timeoutMs)) return false;

  if (
    (input.command === "openUrl" || input.command === "navigate") &&
    !isAllowedBridgeUrl(input.url)
  ) {
    return false;
  }
  if (input.url !== undefined && !isAllowedBridgeUrl(input.url)) {
    return false;
  }
  return true;
}

function commandTimeoutMs(input: BrowserAutomationCommandInput): number {
  return Math.min(
    MAX_COMMAND_TIMEOUT_MS,
    Math.max(1, input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS),
  );
}

interface PendingCommandResult {
  readonly responseToken: string;
  readonly deferred: Deferred.Deferred<BrowserAutomationCommandResult>;
}

export interface BrowserBridgeShape {
  readonly token: string;
  /** undefined, когда слушающий порт неизвестен (bridge выключен). */
  readonly baseUrl: string | undefined;
  /** Env-переменные для подпроцессов харнессов; пусто при выключенном bridge. */
  readonly environmentVariables: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  /** Те же переменные в виде record для слияния в `NodeJS.ProcessEnv`. */
  readonly applyEnvironment: (base: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  readonly publishOpenUrl: (url: string) => Effect.Effect<BrowserBridgeStreamEvent>;
  readonly publishCommand: (
    input: BrowserAutomationCommandInput,
  ) => Effect.Effect<BrowserAutomationCommandResult>;
  readonly resolveCommandResult: (
    input: BrowserAutomationCommandResult & { readonly responseToken: string },
  ) => Effect.Effect<boolean>;
  readonly stream: Stream.Stream<BrowserBridgeStreamEvent>;
}

export class BrowserBridge extends Context.Service<BrowserBridge, BrowserBridgeShape>()(
  "t3/browserBridge",
) {}

export const BrowserBridgeLive = Layer.effect(
  BrowserBridge,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const token = randomBytes(24).toString("hex");
    const baseUrl = config.port > 0 ? `http://127.0.0.1:${config.port}` : undefined;
    const pubsub = yield* PubSub.unbounded<BrowserBridgeStreamEvent>();
    const sequenceRef = yield* Ref.make(0);
    const pendingCommands = new Map<string, PendingCommandResult>();
    const environmentVariables = baseUrl
      ? [
          { name: BROWSER_BRIDGE_URL_ENV, value: baseUrl },
          { name: BROWSER_BRIDGE_TOKEN_ENV, value: token },
        ]
      : [];

    return {
      token,
      baseUrl,
      environmentVariables,
      applyEnvironment: (base) => {
        if (environmentVariables.length === 0) return base;
        const next = { ...base };
        for (const variable of environmentVariables) {
          next[variable.name] = variable.value;
        }
        return next;
      },
      publishOpenUrl: (url) =>
        Ref.updateAndGet(sequenceRef, (sequence) => sequence + 1).pipe(
          Effect.map(
            (sequence) =>
              ({
                version: 1,
                type: "openUrl",
                sequence,
                url,
              }) satisfies BrowserBridgeStreamEvent,
          ),
          Effect.tap((event) => PubSub.publish(pubsub, event)),
        ),
      publishCommand: (input) =>
        Effect.gen(function* () {
          const commandId = randomBytes(12).toString("hex");
          const responseToken = randomBytes(24).toString("hex");
          const deferred = yield* Deferred.make<BrowserAutomationCommandResult>();
          pendingCommands.set(commandId, { responseToken, deferred });

          const sequence = yield* Ref.updateAndGet(sequenceRef, (value) => value + 1);
          yield* PubSub.publish(pubsub, {
            version: 1,
            type: "command",
            sequence,
            commandId,
            responseToken,
            resultUrl: `${baseUrl ?? ""}${BROWSER_BRIDGE_COMMAND_RESULT_PATH}`,
            input,
          } satisfies BrowserBridgeStreamEvent);

          const maybeResult = yield* Deferred.await(deferred).pipe(
            Effect.timeoutOption(Duration.millis(commandTimeoutMs(input))),
            Effect.ensuring(Effect.sync(() => pendingCommands.delete(commandId))),
          );

          if (Option.isSome(maybeResult)) {
            return maybeResult.value;
          }
          return {
            ok: false,
            commandId,
            error: `Browser command timed out after ${commandTimeoutMs(input)}ms.`,
          } satisfies BrowserAutomationCommandResult;
        }),
      resolveCommandResult: (input) =>
        Effect.gen(function* () {
          const pending = pendingCommands.get(input.commandId);
          if (!pending || pending.responseToken !== input.responseToken) {
            return false;
          }
          pendingCommands.delete(input.commandId);
          yield* Deferred.succeed(pending.deferred, {
            ok: input.ok,
            commandId: input.commandId,
            ...(input.data !== undefined ? { data: input.data } : {}),
            ...(input.error !== undefined ? { error: input.error } : {}),
          });
          return true;
        }),
      get stream() {
        return Stream.fromPubSub(pubsub);
      },
    } satisfies BrowserBridgeShape;
  }),
);

export const BrowserBridgeTest = Layer.effect(
  BrowserBridge,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<BrowserBridgeStreamEvent>();
    const sequenceRef = yield* Ref.make(0);
    const pendingCommands = new Map<string, PendingCommandResult>();

    return {
      token: "test-browser-bridge-token",
      baseUrl: undefined,
      environmentVariables: [],
      applyEnvironment: (base) => base,
      publishOpenUrl: (url) =>
        Ref.updateAndGet(sequenceRef, (sequence) => sequence + 1).pipe(
          Effect.map(
            (sequence) =>
              ({
                version: 1,
                type: "openUrl",
                sequence,
                url,
              }) satisfies BrowserBridgeStreamEvent,
          ),
          Effect.tap((event) => PubSub.publish(pubsub, event)),
        ),
      publishCommand: (input) =>
        Effect.gen(function* () {
          const commandId = randomBytes(12).toString("hex");
          const responseToken = randomBytes(24).toString("hex");
          const deferred = yield* Deferred.make<BrowserAutomationCommandResult>();
          pendingCommands.set(commandId, { responseToken, deferred });
          const sequence = yield* Ref.updateAndGet(sequenceRef, (value) => value + 1);
          yield* PubSub.publish(pubsub, {
            version: 1,
            type: "command",
            sequence,
            commandId,
            responseToken,
            resultUrl: BROWSER_BRIDGE_COMMAND_RESULT_PATH,
            input,
          } satisfies BrowserBridgeStreamEvent);
          const maybeResult = yield* Deferred.await(deferred).pipe(
            Effect.timeoutOption(Duration.millis(commandTimeoutMs(input))),
            Effect.ensuring(Effect.sync(() => pendingCommands.delete(commandId))),
          );
          if (Option.isSome(maybeResult)) {
            return maybeResult.value;
          }
          return {
            ok: false,
            commandId,
            error: `Browser command timed out after ${commandTimeoutMs(input)}ms.`,
          } satisfies BrowserAutomationCommandResult;
        }),
      resolveCommandResult: (input) =>
        Effect.gen(function* () {
          const pending = pendingCommands.get(input.commandId);
          if (!pending || pending.responseToken !== input.responseToken) {
            return false;
          }
          pendingCommands.delete(input.commandId);
          yield* Deferred.succeed(pending.deferred, {
            ok: input.ok,
            commandId: input.commandId,
            ...(input.data !== undefined ? { data: input.data } : {}),
            ...(input.error !== undefined ? { error: input.error } : {}),
          });
          return true;
        }),
      get stream() {
        return Stream.fromPubSub(pubsub);
      },
    } satisfies BrowserBridgeShape;
  }),
);
