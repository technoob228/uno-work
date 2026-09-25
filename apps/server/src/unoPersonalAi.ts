/**
 * Personal AI — модели на личном GPU аккаунта (Uno GPU, `gpu.uno4.dev`).
 *
 * Здесь только HTTP к бэкенду и нормализация ответа; провайдер для харнесса
 * собирает UnoDriver, кнопки Start/Stop и ожидание рисует веб (ws.ts → RPC
 * `uno.personalAi.*`).
 *
 * Бэкенд (fishcode `internal/gpu/personal.go`):
 *   GET  /personal/models             — модели, цена за час, состояние;
 *   POST /personal/models/{id}/start  — завести на GPU и разбудить (асинхронно);
 *   POST /personal/models/{id}/stop   — усыпить.
 * Вход — тем же ключом, что и LLM-шлюз. Нет флага gpu у аккаунта → 403, и
 * тогда группы Personal AI в выборе модели просто нет.
 *
 * @module unoPersonalAi
 */
import {
  UNO_PERSONAL_AI_BASE_URL,
  type PersonalAiListResult,
  type PersonalAiModel,
  type PersonalAiModelState,
} from "@t3tools/contracts";

/** Провайдер Personal AI в конфиге uno-code; slug модели — `uno-personal/<id>`. */
export const UNO_PERSONAL_PROVIDER_ID = "uno-personal";

/**
 * Заголовок «тихого» прогрева: пока GPU поднимается, шлюз шлёт статусы
 * SSE-комментариями, а не текстом ответа — иначе «Starting a GPU…» попал бы
 * в историю разговора агента как реплика модели.
 */
export const UNO_PERSONAL_WARMUP_HEADERS = { "X-Uno-Warmup": "quiet" } as const;

const REQUEST_TIMEOUT_MS = 15_000;

const STATES: ReadonlyArray<PersonalAiModelState> = [
  "off",
  "starting",
  "ready",
  "sleeping",
  "failed",
];

export class PersonalAiRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "PersonalAiRequestError";
    this.status = status;
    this.code = code;
  }
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Строка ответа бэкенда (snake_case) → контрактная модель. */
export function normalizePersonalAiModel(raw: unknown): PersonalAiModel | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as Record<string, unknown>;
  const id = str(entry.id);
  if (!id) return undefined;
  const state = STATES.find((candidate) => candidate === entry.state) ?? "off";
  const steps = Array.isArray(entry.steps)
    ? entry.steps.flatMap((step) => {
        if (!step || typeof step !== "object") return [];
        const s = step as Record<string, unknown>;
        const stepId = str(s.id);
        const label = str(s.label);
        const stepState = str(s.state);
        return stepId && label && stepState ? [{ id: stepId, label, state: stepState }] : [];
      })
    : undefined;
  const contextTokens = num(entry.context_tokens);
  const etaS = num(entry.eta_s);
  const startedAt = str(entry.started_at);
  const error = str(entry.error);
  return {
    id,
    name: str(entry.name) ?? id,
    ...(typeof entry.catalog === "boolean" ? { catalog: entry.catalog } : {}),
    size: str(entry.size) ?? "",
    priceUsdPerHour: num(entry.price_usd_per_hour) ?? 0,
    idleSleepS: num(entry.idle_sleep_s) ?? 60,
    state,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(etaS !== undefined ? { etaS } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(steps && steps.length > 0 ? { steps } : {}),
    ...(error ? { error } : {}),
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function request(
  apiKey: string,
  path: string,
  init: { readonly method: "GET" | "POST"; readonly fetchImpl?: FetchLike | undefined },
): Promise<unknown> {
  const fetchImpl = init.fetchImpl ?? fetch;
  const response = await fetchImpl(`${UNO_PERSONAL_AI_BASE_URL}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = str(body?.error) ?? str((body?.error as { type?: unknown } | undefined)?.type);
    const detail = str(body?.detail) ?? str(body?.message);
    throw new PersonalAiRequestError(
      describePersonalAiError(response.status, code, detail),
      response.status,
      code,
    );
  }
  return body;
}

/** Человеческий текст ошибки для тоста в интерфейсе. */
export function describePersonalAiError(
  status: number,
  code: string | undefined,
  detail: string | undefined,
): string {
  switch (code) {
    case "INSUFFICIENT_BALANCE":
      return "Not enough balance to start your GPU. Top up and try again.";
    case "NO_GPU_CAPACITY":
      return "No GPU is free right now. Try again in a few minutes.";
    case "FEATURE_DISABLED":
      return "Personal AI is not enabled for this account yet.";
    case "MODEL_NOT_FOUND":
      return "This model is no longer available on your GPU.";
  }
  if (status === 401) return "Sign in to your Uno account to use Personal AI.";
  if (status === 403) return detail ?? "This Uno key cannot run a personal GPU.";
  return detail ?? `Personal AI request failed (HTTP ${status}).`;
}

/**
 * Список моделей. Нет ключа, нет флага или ключ не пускают на GPU —
 * `available: false` без исключения: для человека это «опции нет», не ошибка.
 */
export async function fetchPersonalAiModels(
  apiKey: string,
  fetchImpl?: FetchLike,
): Promise<PersonalAiListResult> {
  if (apiKey.trim().length === 0) return { available: false, models: [] };
  try {
    const body = (await request(apiKey, "/personal/models", { method: "GET", fetchImpl })) as {
      models?: unknown;
    } | null;
    const rows = Array.isArray(body?.models) ? body.models : [];
    return {
      available: true,
      models: rows.flatMap((row) => normalizePersonalAiModel(row) ?? []),
    };
  } catch (error) {
    if (error instanceof PersonalAiRequestError && (error.status === 401 || error.status === 403)) {
      return { available: false, models: [] };
    }
    throw error;
  }
}

/** Start / Stop одной модели; ответ — её состояние сразу после действия. */
export async function personalAiAction(
  apiKey: string,
  modelId: string,
  action: "start" | "stop",
  fetchImpl?: FetchLike,
): Promise<PersonalAiModel> {
  if (apiKey.trim().length === 0) {
    throw new PersonalAiRequestError("Sign in to your Uno account to use Personal AI.", 401);
  }
  const body = await request(apiKey, `/personal/models/${encodeURIComponent(modelId)}/${action}`, {
    method: "POST",
    fetchImpl,
  });
  const model = normalizePersonalAiModel(body);
  if (!model) {
    throw new PersonalAiRequestError("Personal AI answered with an unexpected response.", 502);
  }
  return model;
}
