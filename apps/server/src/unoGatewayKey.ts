/**
 * UnoGatewayKey — какой ключ Uno вправе увидеть процесс харнесса.
 *
 * `settings.uno.apiKey` — поле с двумя разными жильцами:
 *
 * - на Work-боксе консоль сама записывает туда дочерний ключ шлюза
 *   (`unollm_…`, `back/internal/box/work_llm_key.go`): он умеет только LLM;
 * - на ноутбуке человек вставляет туда ключ аккаунта (`uno_usr_…`), которым
 *   можно заказывать боксы и серверы, читать секреты и тратить баланс.
 *
 * Раньше в окружение харнессов (`UNO_API_KEY`, `OPENAI_API_KEY`, конфиг
 * OpenCode) уходило именно то, что лежит в настройках, — то есть на десктопе
 * агент получал полный ключ аккаунта. Здесь это разделено: наружу, в процесс
 * агента, отдаётся только ключ шлюза. Ключ аккаунта остаётся на сервере
 * (чеканка agent-токена, транскрипция, видео-шлюз, коннекторы).
 *
 * Если в настройках лежит ключ аккаунта, демон один раз чеканит дочерний ключ
 * шлюза (`POST /api/v1/llm/keys`) и хранит его в ServerSecretStore (0600, вне
 * settings.json). Смена ключа аккаунта — перечеканка. Не вышло (нет сети,
 * отозванный ключ) — харнесс остаётся без ключа: это «модель попросит
 * настроить ключ», а не «агент получил право покупать».
 */
import { Context, Duration, Effect, Layer, Ref } from "effect";
import os from "node:os";

import { type ThreadAppLabels, makeThreadAppLabels } from "./appSdk/appTaskLabel.ts";
import { ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";
import {
  looksLikeUnoBoxHostname,
  parseUnoBoxIdFromEnvironment,
} from "./environment/machineKind.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import { fetchControlPlaneJson, parseSettingsBoxId } from "./unoBoxIdentity.ts";

/** Префикс дочерних ключей шлюза, которые чеканит консоль. */
export const UNO_GATEWAY_KEY_PREFIX = "unollm_";

/** Ключ в ServerSecretStore для дочернего ключа, вычеканенного демоном. */
export const UNO_GATEWAY_KEY_SECRET_KEY = "uno-gateway-key";

/** Не дёргать control plane чаще раза в минуту даже при серии create(). */
const CACHE_TTL_MS = 60_000;

export interface StoredGatewayKey {
  readonly secret: string;
  /** Хвост ключа аккаунта, которым чеканили: смена ключа = перечеканка. */
  readonly mintedBy: string;
}

export function parseStoredGatewayKey(bytes: Uint8Array | null): StoredGatewayKey | null {
  if (bytes === null || bytes.length === 0) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as StoredGatewayKey;
    return typeof parsed.secret === "string" && parsed.secret.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** Ключ шлюза не даёт прав на инфраструктуру — его можно отдать агенту. */
export function isGatewayScopedKey(key: string): boolean {
  return key.startsWith(UNO_GATEWAY_KEY_PREFIX);
}

/**
 * Есть ли у машины ключ шлюза:
 * - `ready` — есть;
 * - `pending` — нет, но вот-вот будет: это Uno-бокс, и консоль дописывает ключ
 *   в settings.json через секунды после входа. Чат Uno в это время не
 *   отправляет человека в Settings, а ждёт (`awaitHarnessKey`);
 * - `missing` — нет и не ожидается (ноутбук без входа; бокс, которому ключ так
 *   и не пришёл за {@link GATEWAY_KEY_GRACE}).
 */
export type GatewayKeyState = "ready" | "pending" | "missing";

/** Сколько ждать ключ на боксе с первого вопроса о нём. */
export const GATEWAY_KEY_GRACE = Duration.seconds(90);

export function gatewayKeyState(input: {
  readonly key: string;
  readonly onUnoBox: boolean;
  /** Когда о ключе спросили впервые (мс); отсчёт ожидания. */
  readonly firstAskedAt: number;
  readonly now: number;
  readonly graceMs?: number;
}): GatewayKeyState {
  if (input.key.length > 0) return "ready";
  if (!input.onUnoBox) return "missing";
  const grace = input.graceMs ?? Duration.toMillis(GATEWAY_KEY_GRACE);
  return input.now - input.firstAskedAt < grace ? "pending" : "missing";
}

/** Uno-бокс по дешёвым локальным признакам (как в machineKind.ts). */
export function looksLikeUnoBox(input: {
  readonly envBoxId: string | undefined;
  readonly hostname: string;
  readonly settingsBoxId: number | null | undefined;
  readonly boxToken: string | undefined;
}): boolean {
  return (
    parseUnoBoxIdFromEnvironment(input.envBoxId) !== null ||
    parseSettingsBoxId(input.settingsBoxId) !== null ||
    (input.boxToken?.trim().length ?? 0) > 0 ||
    looksLikeUnoBoxHostname(input.hostname)
  );
}

export interface UnoGatewayKeyShape extends ThreadAppLabels {
  /**
   * Ключ для окружения харнессов и их конфигов. Пустая строка — ключа нет
   * (не задан, не вычеканился); никогда не возвращает ключ аккаунта.
   */
  readonly harnessKey: () => Effect.Effect<string>;
  /** Есть ли ключ, ждём ли его (см. {@link GatewayKeyState}). */
  readonly keyState: () => Effect.Effect<GatewayKeyState>;
  /**
   * Ключ шлюза; пока он `pending` — ждёт его появления, но не дольше
   * `maxWait`. Пустая строка — ключа так и нет.
   */
  readonly awaitHarnessKey: (maxWait?: Duration.Input) => Effect.Effect<string>;
  // labelThread / appOfThread — чей тред: задача приложения машины (Uno App
  // SDK) идёт в шлюз тем же ключом, но с меткой приложения
  // (appSdk/appTaskLabel.ts). Метку ставит только демон.
}

export class UnoGatewayKey extends Context.Service<UnoGatewayKey, UnoGatewayKeyShape>()(
  "t3/UnoGatewayKey",
) {}

interface CacheEntry {
  readonly at: number;
  readonly key: string;
  /** Отпечаток uno.apiKey, для которого посчитан ответ: другой ключ = промах. */
  readonly source: string;
}

/**
 * Короткий отпечаток ключа из настроек (хвост, не сам секрет). Помимо
 * перечеканки дочернего ключа используется гидрацией реестра провайдеров:
 * отпечаток вштамповывается в конверт uno-инстанса, чтобы появление или
 * смена ключа (на Work-боксе консоль дописывает его в settings.json уже
 * после старта демона) пересоздавала инстанс — иначе каталог моделей,
 * снятый один раз при создании, навсегда остаётся пустым.
 */
export function accountKeyFingerprint(apiKey: string): string {
  const trimmed = apiKey.trim();
  return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}

function keyLabel(): string {
  const host = os.hostname().trim();
  return host.length > 0 ? `Uno Work (${host})` : "Uno Work";
}

const makeUnoGatewayKey = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const secretStore = yield* ServerSecretStore;
  const cache = yield* Ref.make<CacheEntry | null>(null);

  const resolve = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const apiKey = current?.uno.apiKey.trim() ?? "";
    if (apiKey.length === 0) return "";
    if (isGatewayScopedKey(apiKey)) return apiKey;

    const fingerprint = accountKeyFingerprint(apiKey);
    const storedBytes = yield* secretStore
      .get(UNO_GATEWAY_KEY_SECRET_KEY)
      .pipe(Effect.orElseSucceed(() => null));
    const stored = parseStoredGatewayKey(storedBytes);
    if (stored !== null && stored.mintedBy === fingerprint) return stored.secret;

    const minted = yield* Effect.tryPromise(() =>
      // The console serves LLM keys at /llm/keys (fishcode handler.go), not
      // under /api/v1 — the old path answered 404, the mint "failed" and a
      // machine holding an account key never got its AI (seen on box 395).
      fetchControlPlaneJson("/llm/keys", apiKey, {
        method: "POST",
        body: JSON.stringify({ label: keyLabel() }),
      }),
    ).pipe(Effect.orElseSucceed(() => null));
    if (minted === null || typeof minted !== "object") {
      yield* Effect.logWarning("uno.gatewayKey.mintFailed");
      return "";
    }
    const record = minted as Record<string, unknown>;
    const secret = typeof record["key"] === "string" ? record["key"] : "";
    if (secret.length === 0) {
      yield* Effect.logWarning("uno.gatewayKey.mintFailed");
      return "";
    }

    yield* secretStore
      .set(
        UNO_GATEWAY_KEY_SECRET_KEY,
        new TextEncoder().encode(
          JSON.stringify({ secret, mintedBy: fingerprint } satisfies StoredGatewayKey),
        ),
      )
      .pipe(Effect.orElseSucceed(() => undefined));
    yield* Effect.logInfo("uno.gatewayKey.minted", { label: keyLabel() });
    return secret;
  });

  // Кэш привязан к ключу в настройках. На Work-боксе демон стартует без ключа,
  // и через секунды консоль дописывает unollm_ в settings.json. Реестр
  // провайдеров тут же пересоздаёт uno-инстанс, но раньше получал из кэша тот
  // же пустой ответ, снятый при старте (TTL минута): каталог моделей оставался
  // пустым навсегда, и первый чат уходил в незалогиненный Claude.
  const harnessKey: UnoGatewayKeyShape["harnessKey"] = () =>
    Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
      const source = accountKeyFingerprint(current?.uno.apiKey ?? "");
      const cached = yield* Ref.get(cache);
      if (cached !== null && cached.source === source && Date.now() - cached.at < CACHE_TTL_MS) {
        return cached.key;
      }
      const key = yield* resolve.pipe(Effect.orElseSucceed(() => ""));
      yield* Ref.set(cache, { at: Date.now(), key, source });
      return key;
    });

  // Отсчёт ожидания ключа — с первого вопроса о нём, а не со старта демона:
  // клон из memory-снапшота «стартовал» ещё при прогреве образа.
  let firstAskedAt: number | null = null;
  const keyState: UnoGatewayKeyShape["keyState"] = () =>
    Effect.gen(function* () {
      const key = yield* harnessKey();
      const now = Date.now();
      firstAskedAt ??= now;
      if (key.length > 0) return "ready" as const;
      const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
      return gatewayKeyState({
        key,
        onUnoBox: looksLikeUnoBox({
          envBoxId: process.env.UNO_BOX_ID,
          hostname: os.hostname(),
          settingsBoxId: current?.uno.boxId,
          boxToken: current?.uno.boxToken,
        }),
        firstAskedAt,
        now,
      });
    });

  const awaitHarnessKey: UnoGatewayKeyShape["awaitHarnessKey"] = (maxWait = GATEWAY_KEY_GRACE) => {
    const deadline = Date.now() + Duration.toMillis(Duration.fromInputUnsafe(maxWait));
    const poll: Effect.Effect<string> = Effect.gen(function* () {
      const state = yield* keyState();
      if (state !== "pending" || Date.now() >= deadline) return yield* harnessKey();
      // Ключ приходит правкой settings.json; кэш настроек обновляет watcher.
      yield* Effect.sleep(Duration.millis(250));
      return yield* poll;
    });
    return poll;
  };

  return {
    harnessKey,
    keyState,
    awaitHarnessKey,
    ...makeThreadAppLabels(),
  } satisfies UnoGatewayKeyShape;
});

export const UnoGatewayKeyLive = Layer.effect(UnoGatewayKey, makeUnoGatewayKey);

/** Тестовый стаб: харнессы получают то, что передали (по умолчанию ничего). */
export const UnoGatewayKeyTest = (key = "") =>
  Layer.sync(UnoGatewayKey, () => ({
    harnessKey: () => Effect.succeed(key),
    keyState: () => Effect.succeed(key.length > 0 ? ("ready" as const) : ("missing" as const)),
    awaitHarnessKey: () => Effect.succeed(key),
    ...makeThreadAppLabels(),
  }));
