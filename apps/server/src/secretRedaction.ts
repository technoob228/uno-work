/**
 * Маскировка секретов в том, что агенты выводят в чат.
 *
 * Харнесс работает под тем же пользователем, что и демон, и может прочитать
 * settings.json, env или файл секретов и вывести значение в шаге («Show me
 * what you can do» → `cat settings.json`). Всё, что харнесс отдаёт, проходит
 * через ProviderService.publishRuntimeEvent — там мы и маскируем, до
 * канонического лога, истории треда и UI.
 *
 * Два слоя:
 *  1. по префиксу — ключи Uno и частые сторонние: ловят и значения, которых
 *     демон никогда не видел (ключ, вставленный в .env проекта);
 *  2. по точному значению — секреты, которые демон знает (ключ аккаунта
 *     старого формата без префикса, bridge-токены, чувствительные env
 *     провайдеров). Регистрирует их тот, кто секрет получил или выпустил.
 *
 * Маскировка — страховка вывода, а не граница доступа: модель провайдера всё
 * равно видит вывод инструмента целиком (он уходит ей напрямую из харнесса).
 */

/** Секреты Uno (консоль fishcode) и частые сторонние форматы. */
const SECRET_TOKEN_PATTERN = new RegExp(
  [
    // Uno: ключ шлюза, токены пользователя/агента/бокса, GPU, refresh.
    String.raw`\b(unollm_|uno_(?:usr|agt|box|gpu|gpc|gps|gpa)_|unor_)[A-Za-z0-9_\-]{12,}`,
    // Anthropic / OpenRouter / OpenAI project keys.
    String.raw`\b(sk-ant-|sk-or-v1-|sk-proj-)[A-Za-z0-9_\-]{16,}`,
    // GitHub.
    String.raw`\b(ghp_|gho_|ghs_|ghu_|github_pat_)[A-Za-z0-9_]{20,}`,
  ].join("|"),
  "g",
);

export const REDACTED = "[redacted]";

/** Короче — слишком велик риск замаскировать обычное слово. */
const MIN_KNOWN_SECRET_LENGTH = 12;
/** Потолок реестра: bridge-токены выпускаются на тред, треды конечны. */
const MAX_KNOWN_SECRETS = 2048;
/** Глубина обхода вложенных payload'ов событий. */
const MAX_DEPTH = 32;

const knownSecrets = new Set<string>();
let knownSecretsPattern: RegExp | null = null;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Запомнить значение секрета, чтобы маскировать его в выводе агентов.
 * Пустые и короткие значения игнорируются.
 */
export function registerKnownSecret(value: string | undefined | null): void {
  const secret = value?.trim();
  if (!secret || secret.length < MIN_KNOWN_SECRET_LENGTH || knownSecrets.has(secret)) return;
  if (knownSecrets.size >= MAX_KNOWN_SECRETS) {
    // Самый старый — первый в порядке вставки.
    const oldest = knownSecrets.values().next().value;
    if (oldest !== undefined) knownSecrets.delete(oldest);
  }
  knownSecrets.add(secret);
  knownSecretsPattern = null;
}

/** Только для тестов. */
export function resetKnownSecretsForTest(): void {
  knownSecrets.clear();
  knownSecretsPattern = null;
}

function knownPattern(): RegExp | null {
  if (knownSecrets.size === 0) return null;
  if (knownSecretsPattern === null) {
    // Длинные первыми: значение, содержащее другое, маскируется целиком.
    const alternatives = [...knownSecrets].toSorted((a, b) => b.length - a.length).map(escapeRegExp);
    knownSecretsPattern = new RegExp(alternatives.join("|"), "g");
  }
  return knownSecretsPattern;
}

/** Замаскировать секреты в строке. Без находок возвращает тот же объект. */
export function redactSecretsInText(text: string): string {
  if (text.length < MIN_KNOWN_SECRET_LENGTH) return text;
  let next = text;
  const known = knownPattern();
  if (known) {
    known.lastIndex = 0;
    next = next.replace(known, REDACTED);
  }
  SECRET_TOKEN_PATTERN.lastIndex = 0;
  next = next.replace(
    SECRET_TOKEN_PATTERN,
    (_match, uno?: string, thirdParty?: string, gh?: string) => {
      const prefix = uno ?? thirdParty ?? gh ?? "";
      return `${prefix}${REDACTED}`;
    },
  );
  return next === text ? text : next;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactSecretsInText(value);
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const redacted = redactValue(entry, depth + 1, seen);
      if (redacted !== entry) changed = true;
      return redacted;
    });
    return changed ? next : value;
  }

  // Только простые объекты: Date, Uint8Array, Map и т.п. не трогаем.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const redacted = redactValue(entry, depth + 1, seen);
    if (redacted !== entry) changed = true;
    next[key] = redacted;
  }
  return changed ? next : value;
}

/**
 * Замаскировать секреты во всех строках структуры (событие харнесса, payload
 * активности). Неизменённые ветки возвращаются по ссылке — на горячем пути
 * стрима без находок это ноль аллокаций сверх обхода.
 */
export function redactSecretsDeep<T>(value: T): T {
  return redactValue(value, 0, new WeakSet()) as T;
}

const UNO_SECRET_VALUE =
  /^(unollm_|uno_(?:usr|agt|box|gpu|gpc|gps|gpa)_|unor_)[A-Za-z0-9_-]{12,}$/;

/** Имена переменных, которые харнессу не нужны ни при каком значении. */
const HARNESS_DENIED_ENV_NAMES = new Set([
  "UNO_WORK_API_KEY",
  "UNO_BOX_TOKEN",
  "UNO_WORK_BOX_TOKEN",
  "UNO_ACCOUNT_API_KEY",
]);

/**
 * Можно ли передать харнессу унаследованную переменную окружения демона.
 *
 * Секреты Uno (ключ аккаунта, токен машины, ключ шлюза) харнессу из
 * наследства не нужны: то, что ему положено, — узкий ключ агента и ключ
 * шлюза — драйвер кладёт сам, поверх. Сторонние ключи (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY из shell на ноутбуке) не трогаем: ими харнесс и работает.
 */
export function isInheritableHarnessEnv(name: string, value: string | undefined): boolean {
  if (HARNESS_DENIED_ENV_NAMES.has(name)) return false;
  const trimmed = value?.trim();
  if (!trimmed) return true;
  if (UNO_SECRET_VALUE.test(trimmed)) return false;
  return !knownSecrets.has(trimmed);
}
