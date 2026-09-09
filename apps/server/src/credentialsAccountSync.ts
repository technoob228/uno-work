/**
 * Синхронизация хранилища логинов через аккаунт Uno.
 *
 * Зачем: хранилище кредов держит демон, а демонов у пользователя несколько —
 * бокс с браузерной версией и локальный на ноуте. Без общего места логин,
 * введённый в браузере, на десктопе пришлось бы вводить заново. Общее место —
 * аккаунтный секрет control plane (`POST /api/v1/secrets`, scope `account`),
 * который уже есть в fishcode и шифруется его мастер-ключом.
 *
 * Модель простая и предсказуемая: **весь набор целиком**.
 * - `push` — заменяет аккаунтный слепок локальным;
 * - `pull` — заменяет локальное хранилище аккаунтным.
 * Никакого построчного merge и tombstone'ов нет намеренно: одиночный
 * пользователь правит пароли редко, а «последний, кто отправил, тот и прав»
 * объяснимо в одну строку. Автоматически делается только `pull` на старте
 * демона с ПУСТЫМ локальным хранилищем (новый бокс подхватывает логины сам) и
 * `push` после изменений — так свежая правка не остаётся только на одной машине.
 *
 * Выключено по умолчанию (`settings.uno.credentialsSync`): пароли покидают
 * машину только по явному согласию.
 *
 * @module CredentialsAccountSync
 */
import { UNO_CONTROL_PLANE_BASE_URL } from "@t3tools/contracts";
import { Effect } from "effect";

import { CredentialsVaultService, type CredentialsBundle } from "./credentialsVault.ts";
import { ServerSettingsService } from "./serverSettings.ts";

/** Имя аккаунтного секрета со слепком хранилища. */
export const ACCOUNT_SECRET_NAME = "unowork.credentials.v1";

export interface AccountSyncOutcome {
  readonly ok: boolean;
  /** Сколько логинов оказалось в хранилище после операции. */
  readonly count?: number;
  readonly error?: string;
}

interface AccountSecretRef {
  readonly id: number;
}

async function controlPlaneJson(
  path: string,
  apiKey: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(`${UNO_CONTROL_PLANE_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // 503 VAULT_NOT_CONFIGURED = на control plane не задан мастер-ключ; текст
    // отдаём как есть, чтобы причина была видна в UI, а не «unknown error».
    throw new Error(
      detail.trim().length > 0
        ? `${response.status}: ${detail.slice(0, 200)}`
        : `HTTP ${response.status}`,
    );
  }
  return (await response.json().catch(() => null)) as unknown;
}

/** id аккаунтного секрета со слепком; null — его ещё нет. */
async function findAccountSecret(apiKey: string): Promise<AccountSecretRef | null> {
  const raw = await controlPlaneJson("/api/v1/secrets?scope_type=account", apiKey);
  const secrets =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)["secrets"]
      : undefined;
  if (!Array.isArray(secrets)) return null;
  for (const entry of secrets) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record["name"] === ACCOUNT_SECRET_NAME && typeof record["id"] === "number") {
      return { id: record["id"] };
    }
  }
  return null;
}

export function encodeBundle(bundle: CredentialsBundle): string {
  return JSON.stringify(bundle);
}

/** Разбор слепка из аккаунта. null — мусор вместо ожидаемой структуры. */
export function decodeBundle(raw: string): CredentialsBundle | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const credentials = (parsed as Record<string, unknown>)["credentials"];
    if (!Array.isArray(credentials)) return null;
    const items = credentials.filter((item): item is Record<string, unknown> => {
      if (typeof item !== "object" || item === null) return false;
      const record = item as Record<string, unknown>;
      return (
        typeof record["url"] === "string" &&
        typeof record["username"] === "string" &&
        typeof record["password"] === "string"
      );
    });
    const credentialsOut: Array<CredentialsBundle["credentials"][number]> = [];
    for (const item of items) {
      const notes = item["notes"];
      credentialsOut.push({
        label: typeof item["label"] === "string" ? item["label"] : String(item["url"]),
        url: String(item["url"]),
        username: String(item["username"]),
        password: String(item["password"]),
        ...(typeof notes === "string" ? { notes } : {}),
      });
    }
    return { version: 1, credentials: credentialsOut };
  } catch {
    return null;
  }
}

const readSyncConfig = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings;
  return { apiKey: settings.uno.apiKey.trim(), enabled: settings.uno.credentialsSync };
}).pipe(Effect.catch(() => Effect.succeed({ apiKey: "", enabled: false })));

function disabledOutcome(apiKey: string, enabled: boolean): AccountSyncOutcome | null {
  if (!enabled) {
    return { ok: false, error: "Синхронизация с аккаунтом Uno выключена в настройках." };
  }
  if (apiKey.length === 0) {
    return { ok: false, error: "Нет ключа аккаунта Uno (Settings → Uno account)." };
  }
  return null;
}

/** Отправить локальное хранилище в аккаунт, заменив прежний слепок. */
export const pushVaultToAccount: Effect.Effect<
  AccountSyncOutcome,
  never,
  CredentialsVaultService | ServerSettingsService
> = Effect.gen(function* () {
  const { apiKey, enabled } = yield* readSyncConfig;
  const blocked = disabledOutcome(apiKey, enabled);
  if (blocked) return blocked;

  const vault = yield* CredentialsVaultService;
  const exported = yield* vault.exportBundle.pipe(
    Effect.map((bundle) => ({ ok: true as const, bundle })),
    Effect.catch((error) => Effect.succeed({ ok: false as const, error: error.message })),
  );
  if (!exported.ok) return { ok: false, error: exported.error };
  const bundle = exported.bundle;
  const value = encodeBundle(bundle);

  return yield* Effect.tryPromise(async () => {
    const existing = await findAccountSecret(apiKey);
    if (existing) {
      await controlPlaneJson(`/api/v1/secrets/${existing.id}/versions`, apiKey, {
        method: "POST",
        body: JSON.stringify({ value, comment: "uno-work credentials vault" }),
      });
    } else {
      await controlPlaneJson("/api/v1/secrets", apiKey, {
        method: "POST",
        body: JSON.stringify({
          scope_type: "account",
          name: ACCOUNT_SECRET_NAME,
          kind: "env",
          value,
          comment: "uno-work credentials vault",
        }),
      });
    }
    return { ok: true, count: bundle.credentials.length } satisfies AccountSyncOutcome;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies AccountSyncOutcome),
    ),
  );
});

/** Забрать слепок из аккаунта, заменив локальное хранилище целиком. */
export const pullVaultFromAccount: Effect.Effect<
  AccountSyncOutcome,
  never,
  CredentialsVaultService | ServerSettingsService
> = Effect.gen(function* () {
  const { apiKey, enabled } = yield* readSyncConfig;
  const blocked = disabledOutcome(apiKey, enabled);
  if (blocked) return blocked;

  const fetched = yield* Effect.tryPromise(async () => {
    const existing = await findAccountSecret(apiKey);
    if (!existing) return null;
    const raw = await controlPlaneJson(`/api/v1/secrets/${existing.id}/reveal`, apiKey, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const value =
      typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)["value"]
        : undefined;
    return typeof value === "string" ? value : null;
  }).pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((error) =>
      Effect.succeed({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  );

  if (!fetched.ok) return { ok: false, error: fetched.error };
  if (fetched.value === null) {
    return { ok: false, error: "В аккаунте Uno ещё нет сохранённых логинов." };
  }
  const bundle = decodeBundle(fetched.value);
  if (!bundle) {
    return { ok: false, error: "Слепок в аккаунте не читается — отправьте его заново." };
  }
  const vault = yield* CredentialsVaultService;
  return yield* vault.replaceAll(bundle).pipe(
    Effect.map(() => ({ ok: true, count: bundle.credentials.length }) satisfies AccountSyncOutcome),
    Effect.catch((error) =>
      Effect.succeed({ ok: false, error: error.message } satisfies AccountSyncOutcome),
    ),
  );
});

/**
 * Автопуш после изменения хранилища: свежая правка не должна остаться только на
 * одной машине. Форкается, чтобы сохранение логина в UI не ждало сети, и никогда
 * не фейлится — выключенный синк или недоступный control plane остаются в логе.
 */
export const pushVaultToAccountInBackground: Effect.Effect<
  void,
  never,
  CredentialsVaultService | ServerSettingsService
> = Effect.gen(function* () {
  const { apiKey, enabled } = yield* readSyncConfig;
  if (!enabled || apiKey.length === 0) return;
  yield* pushVaultToAccount
    .pipe(
      Effect.flatMap((outcome) =>
        outcome.ok
          ? Effect.logDebug("credentials vault pushed to Uno account", { count: outcome.count })
          : Effect.logWarning("credentials vault push failed", { reason: outcome.error }),
      ),
    )
    // Отсоединённый форк: RPC сохранения логина не ждёт сети до control plane.
    .pipe(Effect.forkDetach, Effect.asVoid);
});

/**
 * Старт демона: если синк включён, а локальное хранилище пустое — подтянуть
 * логины из аккаунта. Пустое условие обязательно: `pull` заменяет хранилище
 * целиком, и автоматический pull поверх непустого затирал бы локальные правки.
 */
export const hydrateVaultFromAccountOnStartup: Effect.Effect<
  void,
  never,
  CredentialsVaultService | ServerSettingsService
> = Effect.gen(function* () {
  const { apiKey, enabled } = yield* readSyncConfig;
  if (!enabled || apiKey.length === 0) return;
  const vault = yield* CredentialsVaultService;
  const local = yield* vault.list.pipe(Effect.catch(() => Effect.succeed([])));
  if (local.length > 0) return;
  const outcome = yield* pullVaultFromAccount;
  yield* outcome.ok
    ? Effect.logInfo("credentials vault hydrated from Uno account", { count: outcome.count })
    : Effect.logDebug("credentials vault not hydrated from Uno account", {
        reason: outcome.error,
      });
});
