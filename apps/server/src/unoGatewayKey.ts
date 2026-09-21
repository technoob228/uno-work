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
import { Context, Effect, Layer, Ref } from "effect";
import os from "node:os";

import { ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import { fetchControlPlaneJson } from "./unoBoxIdentity.ts";

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

export interface UnoGatewayKeyShape {
  /**
   * Ключ для окружения харнессов и их конфигов. Пустая строка — ключа нет
   * (не задан, не вычеканился); никогда не возвращает ключ аккаунта.
   */
  readonly harnessKey: () => Effect.Effect<string>;
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

  return { harnessKey } satisfies UnoGatewayKeyShape;
});

export const UnoGatewayKeyLive = Layer.effect(UnoGatewayKey, makeUnoGatewayKey);

/** Тестовый стаб: харнессы получают то, что передали (по умолчанию ничего). */
export const UnoGatewayKeyTest = (key = "") =>
  Layer.succeed(UnoGatewayKey, { harnessKey: () => Effect.succeed(key) });
