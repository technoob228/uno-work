/**
 * UnoAgentAccess — доставка Uno-идентичности в агентские сессии.
 *
 * Демон на Uno-боксе чеканит через control plane scoped agent-токен своего
 * бокса (POST /api/v1/boxes/{id}/agent-token, уровень — settings.uno.agentAccess)
 * и отдаёт драйверам харнесов пару переменных окружения:
 *
 *   UNO_AGENT_API_KEY — scoped uno_agt_ токен (не полный ключ аккаунта);
 *   UNO_API_URL       — control plane (console.uno4.dev);
 *   UNO_BOX_ID        — номер бокса, на котором живёт агент.
 *
 * Свой бокс демон находит сам (см. `unoBoxIdentity.ts`): по совпадению
 * internal_ip бокса с локальными интерфейсами, с фолбэком на уникальное
 * совпадение hostname ↔ имя бокса. Не Uno-бокс (ноут, BYO-VM без ключа) —
 * переменные просто не появляются.
 *
 * Токен хранится в ServerSecretStore (0600, вне settings.json); в настройках
 * живёт только уровень доступа. Смена уровня или ключа аккаунта приводит к
 * перечеканке — control plane при этом отзывает предыдущий токен бокса.
 */
import {
  UNO_CONTROL_PLANE_BASE_URL,
  clampUnoAgentAccessLevel,
  type MintableUnoAgentAccessLevel,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Ref } from "effect";

import { ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";
import { ServerSettingsService } from "./serverSettings.ts";
import {
  UNO_AGENT_TOKEN_SECRET_KEY,
  discoverOwnBoxId,
  fetchControlPlaneJson,
  parseStoredAgentToken,
  type StoredAgentToken,
} from "./unoBoxIdentity.ts";

const SECRET_STORE_KEY = UNO_AGENT_TOKEN_SECRET_KEY;
/** Не дёргать control plane чаще, чем раз в минуту, даже при серии create(). */
const CACHE_TTL_MS = 60_000;
/** Перечеканивать заранее, чтобы токен не истёк посреди длинной сессии. */
const RENEW_BEFORE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export interface UnoAgentAccessShape {
  /**
   * Env-переменные для процессов харнесов; пустой объект, когда доступ
   * выключен, ключа аккаунта нет или бокс себя не опознал. Никогда не падает —
   * отсутствие токена не должно ломать создание инстанса.
   */
  readonly environment: () => Effect.Effect<Record<string, string>>;
}

export class UnoAgentAccess extends Context.Service<UnoAgentAccess, UnoAgentAccessShape>()(
  "t3/UnoAgentAccess",
) {}

interface CacheEntry {
  readonly at: number;
  readonly env: Record<string, string>;
}

function accountKeyFingerprint(apiKey: string): string {
  return apiKey.length <= 4 ? apiKey : apiKey.slice(-4);
}

function storedStillValid(
  stored: StoredAgentToken,
  access: string,
  keyFingerprint: string,
): boolean {
  if (stored.access !== access || stored.mintedBy !== keyFingerprint) return false;
  if (stored.expiresAt === null) return true;
  const expiresAt = Date.parse(stored.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt - Date.now() > RENEW_BEFORE_EXPIRY_MS;
}

function environmentFor(stored: StoredAgentToken): Record<string, string> {
  return {
    UNO_AGENT_API_KEY: stored.token,
    UNO_API_URL: UNO_CONTROL_PLANE_BASE_URL,
    UNO_BOX_ID: String(stored.boxId),
  };
}

const makeUnoAgentAccess = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const secretStore = yield* ServerSecretStore;
  const cache = yield* Ref.make<CacheEntry | null>(null);

  const resolve = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => null));
    const apiKey = current?.uno.apiKey.trim() ?? "";
    // Покупки агенту не выдаём: "purchase" из старых настроек понижается до
    // "manage", и токен с `infra:purchase` перечеканивается при первом же
    // обращении (control plane отзывает предыдущий токен бокса).
    const access: MintableUnoAgentAccessLevel = clampUnoAgentAccessLevel(
      current?.uno.agentAccess ?? "read",
    );
    if (apiKey.length === 0 || access === "off") return {};

    const keyFingerprint = accountKeyFingerprint(apiKey);
    const storedBytes = yield* secretStore
      .get(SECRET_STORE_KEY)
      .pipe(Effect.orElseSucceed(() => null));
    const stored = parseStoredAgentToken(storedBytes);
    if (stored !== null && storedStillValid(stored, access, keyFingerprint)) {
      return environmentFor(stored);
    }

    const boxId =
      stored !== null && stored.mintedBy === keyFingerprint
        ? stored.boxId
        : yield* Effect.tryPromise(() => discoverOwnBoxId(apiKey)).pipe(
            Effect.orElseSucceed(() => null),
          );
    if (boxId === null) return {};

    const minted = yield* Effect.tryPromise(() =>
      fetchControlPlaneJson(`/api/v1/boxes/${boxId}/agent-token`, apiKey, {
        method: "POST",
        body: JSON.stringify({ access }),
      }),
    ).pipe(Effect.orElseSucceed(() => null));
    if (minted === null || typeof minted !== "object") return {};
    const record = minted as Record<string, unknown>;
    const token = typeof record["token"] === "string" ? record["token"] : "";
    if (token.length === 0) return {};

    const next: StoredAgentToken = {
      token,
      access,
      boxId,
      expiresAt: typeof record["expires_at"] === "string" ? record["expires_at"] : null,
      mintedBy: keyFingerprint,
    };
    yield* secretStore
      .set(SECRET_STORE_KEY, new TextEncoder().encode(JSON.stringify(next)))
      .pipe(Effect.orElseSucceed(() => undefined));
    yield* Effect.logInfo("uno.agentAccess.minted", { boxId, access });
    return environmentFor(next);
  });

  const environment: UnoAgentAccessShape["environment"] = () =>
    Effect.gen(function* () {
      const cached = yield* Ref.get(cache);
      if (cached !== null && Date.now() - cached.at < CACHE_TTL_MS) return cached.env;
      const env = yield* resolve.pipe(Effect.orElseSucceed(() => ({}) as Record<string, string>));
      yield* Ref.set(cache, { at: Date.now(), env });
      return env;
    });

  return { environment } satisfies UnoAgentAccessShape;
});

export const UnoAgentAccessLive = Layer.effect(UnoAgentAccess, makeUnoAgentAccess);

/** Тестовый стаб: агентского токена нет, env всегда пустой. */
export const UnoAgentAccessTest = Layer.succeed(UnoAgentAccess, {
  environment: () => Effect.succeed({}),
});
