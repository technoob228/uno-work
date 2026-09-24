import { randomBytes, timingSafeEqual } from "node:crypto";

import type {
  BridgeSecretRequestEvent,
  BrowserAutomationCommandInput,
  BrowserAutomationCommandResult,
  BrowserBridgeRequestContext,
  BrowserBridgeStreamEvent,
  PreviewTabScope,
} from "@t3tools/contracts";
import { Context, Deferred, Duration, Effect, Layer, Option, PubSub, Ref, Stream } from "effect";

import { ServerConfig } from "./config.ts";
import { registerKnownSecret } from "./secretRedaction.ts";

/**
 * Мост «харнесс → встроенный браузер».
 *
 * Сервер раздаёт подпроцессам харнессов пару env-переменных
 * (`UNO_WORK_BRIDGE_URL` + `UNO_WORK_BRIDGE_TOKEN`). Модель открывает страницу
 * пользователю обычным curl-запросом на `POST /api/browser/open`; сервер
 * пушит событие подписчикам (web-клиентам) через `subscribeBrowserBridge`.
 *
 * **Токен — всегда на тред.** Раньше в окружении каждого харнесса лежал общий
 * токен машины, и любой процесс, запущенный агентом, мог действовать от имени
 * «любого чата»: открыть вкладку, попросить секрет, написать в чужой тред,
 * дёрнуть connector-нотификацию. Теперь токен выдаётся на пару «тред + cwd»
 * при старте хода, а ручки моста требуют, чтобы тред был назван токеном.
 * Базовый токен машины остаётся только как метка старых сессий: он не
 * попадает в окружение и получает внятный 403 вместо тишины.
 */

export const BROWSER_BRIDGE_URL_ENV = "UNO_WORK_BRIDGE_URL";
export const BROWSER_BRIDGE_TOKEN_ENV = "UNO_WORK_BRIDGE_TOKEN";
export const BROWSER_BRIDGE_OPEN_PATH = "/api/browser/open";
export const BROWSER_BRIDGE_COMMAND_PATH = "/api/browser/command";
export const BROWSER_BRIDGE_COMMAND_RESULT_PATH = "/api/browser/command/result";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;

// «Позови человека» ждёт человека, а не страницу: минуты, как у секретов.
const DEFAULT_HELP_TIMEOUT_MS = 600_000;
const MAX_HELP_TIMEOUT_MS = 1_800_000;
const MAX_HELP_REASON_LENGTH = 500;

// Запрос секрета ждёт человека, а не браузер — таймауты в минутах.
const DEFAULT_SECRET_TIMEOUT_MS = 900_000;
const MAX_SECRET_TIMEOUT_MS = 3_600_000;
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
  "requestHelp",
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

/**
 * Уровень вкладки из тела запроса агента. Мусор и незнакомые значения молча
 * деградируют в undefined — клиент подставит уровень по умолчанию (чат).
 */
export function normalizeTabScope(rawScope: unknown): PreviewTabScope | undefined {
  return rawScope === "chat" || rawScope === "project" || rawScope === "global"
    ? rawScope
    : undefined;
}

const MAX_FILE_PATH_LENGTH = 4096;

/**
 * Путь файла для открытия в панели: абсолютный или `~`-относительный.
 * Существование не проверяется здесь — это делает HTTP-роут, у которого есть
 * FileSystem; валидатор отсекает только мусор и относительные пути (их не от
 * чего резолвить — cwd харнесса серверу неизвестен достоверно).
 */
export function isAllowedBridgeFilePath(rawPath: unknown): rawPath is string {
  if (typeof rawPath !== "string") return false;
  const trimmed = rawPath.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FILE_PATH_LENGTH) return false;
  if (trimmed.includes("\0") || trimmed.includes("\n")) return false;
  return (
    trimmed.startsWith("/") ||
    trimmed === "~" ||
    trimmed.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  );
}

function isOptionalString(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isOptionalTimeout(value: unknown, max: number): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max)
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
  if (input.fullPage !== undefined && typeof input.fullPage !== "boolean") return false;
  const isHelp = input.command === "requestHelp";
  if (!isOptionalTimeout(input.timeoutMs, isHelp ? MAX_HELP_TIMEOUT_MS : MAX_COMMAND_TIMEOUT_MS)) {
    return false;
  }
  if (
    isHelp &&
    (typeof input.text !== "string" ||
      input.text.trim().length === 0 ||
      input.text.length > MAX_HELP_REASON_LENGTH)
  ) {
    return false;
  }

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

export function commandTimeoutMs(input: BrowserAutomationCommandInput): number {
  if (input.command === "requestHelp") {
    return Math.min(
      MAX_HELP_TIMEOUT_MS,
      Math.max(1_000, input.timeoutMs ?? DEFAULT_HELP_TIMEOUT_MS),
    );
  }
  return Math.min(
    MAX_COMMAND_TIMEOUT_MS,
    Math.max(1, input.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS),
  );
}

interface PendingCommandResult {
  readonly responseToken: string;
  readonly deferred: Deferred.Deferred<BrowserAutomationCommandResult>;
}

/** Что вернётся агенту из `POST /api/secrets/request`. Значения секрета тут нет. */
export interface SecretRequestOutcome {
  readonly ok: boolean;
  readonly name?: string;
  readonly file?: string;
  readonly error?: string;
}

/** Метаданные запроса секрета — по ним result-роут пишет env-файл. */
export interface PendingSecretRequestMeta {
  readonly name: string;
  readonly targetFile: string;
  readonly cwd: string;
}

interface PendingSecretRequest extends PendingSecretRequestMeta {
  readonly responseToken: string;
  readonly deferred: Deferred.Deferred<SecretRequestOutcome>;
  /** Опубликованное событие целиком — для реплея новым подписчикам стрима. */
  readonly event: BridgeSecretRequestEvent;
}

export function secretRequestTimeoutMs(timeoutMs: number | undefined): number {
  return Math.min(MAX_SECRET_TIMEOUT_MS, Math.max(1_000, timeoutMs ?? DEFAULT_SECRET_TIMEOUT_MS));
}

const MAX_CONTEXT_CWD_LENGTH = 4096;
const MAX_CONTEXT_THREAD_ID_LENGTH = 200;

/**
 * Отбрасывает пустые/непомерные значения контекста; undefined, когда после
 * очистки не осталось ни одного поля — событие уходит без контекста.
 */
export function normalizeBridgeRequestContext(input: {
  readonly threadId?: string | undefined;
  readonly cwd?: string | undefined;
}): BrowserBridgeRequestContext | undefined {
  const threadId = input.threadId?.trim();
  const cwd = input.cwd?.trim();
  const context = {
    ...(threadId && threadId.length <= MAX_CONTEXT_THREAD_ID_LENGTH ? { threadId } : {}),
    ...(cwd && cwd.length <= MAX_CONTEXT_CWD_LENGTH ? { cwd } : {}),
  };
  return Object.keys(context).length > 0 ? context : undefined;
}

/**
 * Результат проверки bridge-токена.
 *
 * `kind: "thread"` — токен выдан сессии конкретного треда, контекст назван им
 * самим. `kind: "legacy"` — базовый токен машины: так представляются сессии,
 * поднятые до обновления. Ручки моста на него отвечают отказом с причиной.
 */
export type BridgeTokenKind = "thread" | "legacy";

export interface BridgeAuthorization {
  readonly context: BrowserBridgeRequestContext | undefined;
  readonly kind: BridgeTokenKind;
}

/** Отказ моста: код и текст, который агент прочитает в теле ответа. */
export interface BridgeThreadRefusal {
  readonly status: 401 | 403;
  readonly error: string;
  readonly message: string;
}

export type BridgeThreadResolution =
  | { readonly ok: true; readonly threadId: string; readonly context: BrowserBridgeRequestContext }
  | ({ readonly ok: false } & BridgeThreadRefusal);

const UNAUTHORIZED_REFUSAL: BridgeThreadRefusal = {
  status: 401,
  error: "unauthorized",
  message: "Unauthorized",
};

const THREAD_REQUIRED_REFUSAL: BridgeThreadRefusal = {
  status: 403,
  error: "thread_context_required",
  message:
    "Нужен bridge-токен сессии треда ($UNO_WORK_BRIDGE_TOKEN внутри чата). " +
    "Общий токен машины больше не принимается: перезапусти агента в чате, " +
    "чтобы сессия получила свой токен.",
};

/**
 * Единая проверка для всех ручек моста: запрос действует от имени треда,
 * названного его же токеном. Чужой тред своим токеном не назвать — контекст
 * приходит из карты выдачи на сервере, а не из тела запроса.
 */
export function requireBridgeThread(
  authorization: BridgeAuthorization | null,
): BridgeThreadResolution {
  if (authorization === null) return { ok: false, ...UNAUTHORIZED_REFUSAL };
  const threadId = authorization.context?.threadId;
  if (authorization.kind !== "thread" || threadId === undefined || threadId.length === 0) {
    return { ok: false, ...THREAD_REQUIRED_REFUSAL };
  }
  return { ok: true, threadId, context: authorization.context! };
}

export interface BrowserBridgeShape {
  readonly token: string;
  /** undefined, когда слушающий порт неизвестен (bridge выключен). */
  readonly baseUrl: string | undefined;
  /**
   * Bridge-переменные для слияния в `NodeJS.ProcessEnv`. Токен появляется
   * только вместе с тредом; без него остаётся один адрес, а уже лежавший в
   * окружении токен вычищается — процесс инстанса не должен унести токен
   * чужой сессии.
   */
  readonly applyEnvironment: (
    base: NodeJS.ProcessEnv,
    context?: BrowserBridgeRequestContext,
  ) => NodeJS.ProcessEnv;
  /**
   * Токен сессии треда: выдаётся при старте хода и живёт, пока жив сервер.
   * `null` — контекст без треда, такому запросу мост откажет.
   */
  readonly issueThreadToken: (context: BrowserBridgeRequestContext | undefined) => string | null;
  /** Оверлей bridge-переменных со scoped-токеном для точек спавна харнессов. */
  readonly scopedEnvironment: (
    context: BrowserBridgeRequestContext | undefined,
  ) => Record<string, string>;
  /** null — токен не принят; иначе контекст, к которому он был выдан. */
  readonly authorize: (authorizationHeader: string | undefined) => BridgeAuthorization | null;
  readonly publishOpenUrl: (
    url: string,
    context?: BrowserBridgeRequestContext,
    scope?: PreviewTabScope,
  ) => Effect.Effect<BrowserBridgeStreamEvent>;
  readonly publishOpenFile: (
    path: string,
    context?: BrowserBridgeRequestContext,
    scope?: PreviewTabScope,
  ) => Effect.Effect<BrowserBridgeStreamEvent>;
  readonly publishCommand: (
    input: BrowserAutomationCommandInput,
    context?: BrowserBridgeRequestContext,
  ) => Effect.Effect<BrowserAutomationCommandResult>;
  readonly resolveCommandResult: (
    input: BrowserAutomationCommandResult & { readonly responseToken: string },
  ) => Effect.Effect<boolean>;
  /**
   * Запрос секрета от агента: пушит `secretRequest`-событие web-клиентам и
   * блокируется до сабмита/отказа пользователя или таймаута.
   */
  readonly publishSecretRequest: (
    input: {
      readonly name: string;
      readonly description?: string;
      readonly targetFile: string;
      readonly cwd: string;
      readonly timeoutMs?: number;
    },
    context?: BrowserBridgeRequestContext,
  ) => Effect.Effect<SecretRequestOutcome>;
  /** Метаданные висящего запроса секрета; null — неизвестный id/токен. */
  readonly peekSecretRequest: (input: {
    readonly requestId: string;
    readonly responseToken: string;
  }) => Effect.Effect<PendingSecretRequestMeta | null>;
  /** Закрывает запрос секрета и будит ожидающего агента. */
  readonly completeSecretRequest: (input: {
    readonly requestId: string;
    readonly responseToken: string;
    readonly outcome: SecretRequestOutcome;
  }) => Effect.Effect<boolean>;
  readonly stream: Stream.Stream<BrowserBridgeStreamEvent>;
  /**
   * Есть ли живые подписчики стрима (подключённые web-клиенты). Счётчик
   * глобальный, не per-context: «подписан хоть кто-то» достаточно для выбора
   * исполнителя auto-роутингом.
   */
  readonly hasSubscribers: Effect.Effect<boolean>;
  readonly subscriberCount: Effect.Effect<number>;
}

export class BrowserBridge extends Context.Service<BrowserBridge, BrowserBridgeShape>()(
  "t3/browserBridge",
) {}

export function bridgeContextKey(context: BrowserBridgeRequestContext): string {
  return `${context.threadId ?? ""}\u0000${context.cwd ?? ""}`;
}

/** Экспорт для тестов: Live/Test-слои строятся из этой фабрики. */
export const makeBrowserBridge = (input: {
  readonly token: string;
  readonly baseUrl: string | undefined;
}) =>
  Effect.gen(function* () {
    const { token, baseUrl } = input;
    const pubsub = yield* PubSub.unbounded<BrowserBridgeStreamEvent>();
    const sequenceRef = yield* Ref.make(0);
    const subscriberCountRef = yield* Ref.make(0);
    const pendingCommands = new Map<string, PendingCommandResult>();
    const pendingSecretRequests = new Map<string, PendingSecretRequest>();
    // Scoped-токены: один на контекст (тред/проект), переживают рестарты
    // харнесса в рамках жизни сервера. Треды конечны — рост карт ограничен.
    const scopedTokenByContextKey = new Map<string, string>();
    const contextByScopedToken = new Map<string, BrowserBridgeRequestContext>();
    const issueThreadToken = (context: BrowserBridgeRequestContext | undefined): string | null => {
      const normalized = context ? normalizeBridgeRequestContext(context) : undefined;
      if (!normalized?.threadId) return null;
      const key = bridgeContextKey(normalized);
      let scopedToken = scopedTokenByContextKey.get(key);
      if (!scopedToken) {
        scopedToken = randomBytes(24).toString("hex");
        registerKnownSecret(scopedToken);
        scopedTokenByContextKey.set(key, scopedToken);
        contextByScopedToken.set(scopedToken, normalized);
      }
      return scopedToken;
    };

    const scopedEnvironment = (
      context: BrowserBridgeRequestContext | undefined,
    ): Record<string, string> => {
      if (!baseUrl) return {};
      const scopedToken = issueThreadToken(context);
      // Без треда токена нет: адрес отдаём, чтобы запрос дошёл до сервера и
      // агент прочитал причину отказа, а не упёрся в пустую переменную.
      if (scopedToken === null) return { [BROWSER_BRIDGE_URL_ENV]: baseUrl };
      return { [BROWSER_BRIDGE_URL_ENV]: baseUrl, [BROWSER_BRIDGE_TOKEN_ENV]: scopedToken };
    };

    const authorize = (authorizationHeader: string | undefined): BridgeAuthorization | null => {
      const presented = authorizationHeader?.replace(/^Bearer\s+/i, "").trim() ?? "";
      if (presented.length === 0) return null;
      const scopedContext = contextByScopedToken.get(presented);
      if (scopedContext) return { context: scopedContext, kind: "thread" };
      // Базовый токен машины больше не открывает ручки, но узнаётся: сессия,
      // поднятая до обновления, получает внятный отказ вместо 401.
      if (
        presented.length === token.length &&
        timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(token, "utf8"))
      ) {
        return { context: undefined, kind: "legacy" };
      }
      return null;
    };

    return {
      token,
      baseUrl,
      applyEnvironment: (base, context) => {
        const overlay = scopedEnvironment(context);
        const next: NodeJS.ProcessEnv = { ...base, ...overlay };
        if (overlay[BROWSER_BRIDGE_TOKEN_ENV] === undefined) {
          delete next[BROWSER_BRIDGE_TOKEN_ENV];
        }
        return next;
      },
      issueThreadToken,
      scopedEnvironment,
      authorize,
      publishOpenUrl: (url, context?, scope?) =>
        Ref.updateAndGet(sequenceRef, (sequence) => sequence + 1).pipe(
          Effect.map(
            (sequence) =>
              ({
                version: 1,
                type: "openUrl",
                sequence,
                url,
                ...(scope ? { scope } : {}),
                ...(context ? { context } : {}),
              }) satisfies BrowserBridgeStreamEvent,
          ),
          Effect.tap((event) => PubSub.publish(pubsub, event)),
        ),
      publishOpenFile: (path, context?, scope?) =>
        Ref.updateAndGet(sequenceRef, (sequence) => sequence + 1).pipe(
          Effect.map(
            (sequence) =>
              ({
                version: 1,
                type: "openFile",
                sequence,
                path,
                ...(scope ? { scope } : {}),
                ...(context ? { context } : {}),
              }) satisfies BrowserBridgeStreamEvent,
          ),
          Effect.tap((event) => PubSub.publish(pubsub, event)),
        ),
      publishCommand: (input, context?) =>
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
            ...(context ? { context } : {}),
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
      publishSecretRequest: (input, context?) =>
        Effect.gen(function* () {
          // Повторный запрос того же секрета вытесняет висящий: иначе у
          // пользователя две плашки на одно имя, и значение, введённое в
          // старую, уходит агенту, который его уже не ждёт.
          const stale = [...pendingSecretRequests.entries()].find(
            ([, pending]) => pending.name === input.name && pending.cwd === input.cwd,
          );
          if (stale) {
            const [staleRequestId, stalePending] = stale;
            pendingSecretRequests.delete(staleRequestId);
            yield* Deferred.succeed(stalePending.deferred, {
              ok: false,
              name: stalePending.name,
              error: "Superseded by a newer request for the same secret.",
            });
            const staleSequence = yield* Ref.updateAndGet(sequenceRef, (value) => value + 1);
            yield* PubSub.publish(pubsub, {
              version: 1,
              type: "secretSettled",
              sequence: staleSequence,
              requestId: staleRequestId,
            } satisfies BrowserBridgeStreamEvent);
          }

          const requestId = randomBytes(12).toString("hex");
          const responseToken = randomBytes(24).toString("hex");
          const deferred = yield* Deferred.make<SecretRequestOutcome>();

          const sequence = yield* Ref.updateAndGet(sequenceRef, (value) => value + 1);
          const event = {
            version: 1,
            type: "secretRequest",
            sequence,
            requestId,
            responseToken,
            name: input.name,
            ...(input.description !== undefined ? { description: input.description } : {}),
            targetFile: input.targetFile,
            cwd: input.cwd,
            ...(context ? { context } : {}),
          } satisfies BridgeSecretRequestEvent;
          pendingSecretRequests.set(requestId, {
            responseToken,
            deferred,
            name: input.name,
            targetFile: input.targetFile,
            cwd: input.cwd,
            event,
          });
          yield* PubSub.publish(pubsub, event);

          const timeoutMs = secretRequestTimeoutMs(input.timeoutMs);
          const maybeOutcome = yield* Deferred.await(deferred).pipe(
            Effect.timeoutOption(Duration.millis(timeoutMs)),
            Effect.ensuring(Effect.sync(() => pendingSecretRequests.delete(requestId))),
          );

          if (Option.isSome(maybeOutcome)) {
            return maybeOutcome.value;
          }
          const settledSequence = yield* Ref.updateAndGet(sequenceRef, (value) => value + 1);
          yield* PubSub.publish(pubsub, {
            version: 1,
            type: "secretSettled",
            sequence: settledSequence,
            requestId,
          } satisfies BrowserBridgeStreamEvent);
          return {
            ok: false,
            error: `Secret request timed out after ${timeoutMs}ms — the user didn't respond.`,
          } satisfies SecretRequestOutcome;
        }),
      peekSecretRequest: (input) =>
        Effect.sync(() => {
          const pending = pendingSecretRequests.get(input.requestId);
          if (!pending || pending.responseToken !== input.responseToken) {
            return null;
          }
          return { name: pending.name, targetFile: pending.targetFile, cwd: pending.cwd };
        }),
      completeSecretRequest: (input) =>
        Effect.gen(function* () {
          const pending = pendingSecretRequests.get(input.requestId);
          if (!pending || pending.responseToken !== input.responseToken) {
            return false;
          }
          pendingSecretRequests.delete(input.requestId);
          yield* Deferred.succeed(pending.deferred, input.outcome);
          const sequence = yield* Ref.updateAndGet(sequenceRef, (value) => value + 1);
          yield* PubSub.publish(pubsub, {
            version: 1,
            type: "secretSettled",
            sequence,
            requestId: input.requestId,
          } satisfies BrowserBridgeStreamEvent);
          return true;
        }),
      get stream() {
        return Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(pubsub);
            yield* Ref.update(subscriberCountRef, (count) => count + 1);
            // Реплей висящих запросов секретов: клиент мог перезагрузиться или
            // переподключиться после публикации — без реплея плашка теряется,
            // а агент ждёт до таймаута. Снимок берётся после подписки: дубль
            // клиент дедуплицирует по requestId, а settled-событие, успевшее
            // между подпиской и снимком, придёт следом и снимет плашку.
            const pendingReplay = [...pendingSecretRequests.values()].map(
              (pending) => pending.event as BrowserBridgeStreamEvent,
            );
            return Stream.fromIterable(pendingReplay).pipe(
              Stream.concat(Stream.fromSubscription(subscription)),
              Stream.ensuring(Ref.update(subscriberCountRef, (count) => count - 1)),
            );
          }),
        );
      },
      hasSubscribers: Ref.get(subscriberCountRef).pipe(Effect.map((count) => count > 0)),
      subscriberCount: Ref.get(subscriberCountRef),
    } satisfies BrowserBridgeShape;
  });

export const BrowserBridgeLive = Layer.effect(
  BrowserBridge,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return yield* makeBrowserBridge({
      token: randomBytes(24).toString("hex"),
      baseUrl: config.port > 0 ? `http://127.0.0.1:${config.port}` : undefined,
    });
  }),
);

export const BrowserBridgeTest = Layer.effect(
  BrowserBridge,
  makeBrowserBridge({ token: "test-browser-bridge-token", baseUrl: undefined }),
);
