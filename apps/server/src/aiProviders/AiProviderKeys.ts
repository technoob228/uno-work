/**
 * AiProviderKeys — "bring your own key": API keys of other AI providers the
 * person stored on this machine (contracts: aiProviders.ts).
 *
 * Keys sit in the daemon's ServerSecretStore (0600 files in the state dir,
 * outside settings.json), one entry per provider. Nothing that leaves this
 * module carries a key: summaries show the last four characters, test and
 * model-list errors are written here and never echo the request. The only
 * reader of the raw key is {@link AiProviderKeysShape.resolve} — the Hermes
 * driver puts it into the harness process environment of the assistant chat
 * that asked for this provider.
 *
 * @module aiProviders/AiProviderKeys
 */
import {
  type AiProviderKeySetInput,
  type AiProviderKeySummary,
  type AiProviderKeyTestInput,
  type AiProviderKeyTestResult,
  type AssistantLlmModel,
  BYOK_PROVIDER_BASE_URLS,
  BYOK_PROVIDER_IDS,
  type ByokProviderId,
} from "@t3tools/contracts";
import { secretKeyHint } from "@t3tools/shared/assistantLlm";
import { Context, Data, Effect, Layer } from "effect";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";

const SECRET_PREFIX = "ai-provider-key-";
const MODELS_TIMEOUT_MS = 10_000;

export class AiProviderKeyError extends Data.TaggedError("AiProviderKeyError")<{
  readonly message: string;
  readonly status: number;
}> {}

export interface ResolvedProviderKey {
  readonly apiKey: string;
  readonly baseUrl: string;
}

interface StoredProviderKey {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly updatedAt: string;
}

export type ProviderModelsResult =
  | { readonly ok: true; readonly models: ReadonlyArray<AssistantLlmModel> }
  | { readonly ok: false; readonly error: string };

export interface AiProviderKeysShape {
  readonly list: () => Effect.Effect<ReadonlyArray<AiProviderKeySummary>>;
  readonly set: (
    input: AiProviderKeySetInput,
  ) => Effect.Effect<AiProviderKeySummary, AiProviderKeyError>;
  readonly remove: (provider: ByokProviderId) => Effect.Effect<void, AiProviderKeyError>;
  /** The stored key — for the harness environment only. Null: none stored. */
  readonly resolve: (provider: ByokProviderId) => Effect.Effect<ResolvedProviderKey | null>;
  readonly test: (input: AiProviderKeyTestInput) => Effect.Effect<AiProviderKeyTestResult>;
  /** Models the stored key sees (`GET {baseUrl}/models`). */
  readonly listModels: (provider: ByokProviderId) => Effect.Effect<ProviderModelsResult>;
}

export class AiProviderKeys extends Context.Service<AiProviderKeys, AiProviderKeysShape>()(
  "t3/aiProviders/AiProviderKeys",
) {}

export function secretNameForProvider(provider: ByokProviderId): string {
  return `${SECRET_PREFIX}${provider}`;
}

/**
 * Base URL of a provider: fixed for the built-in ones, the person's for
 * `custom` (http(s), no trailing slash). Null: not a usable URL.
 */
export function resolveProviderBaseUrl(
  provider: ByokProviderId,
  customBaseUrl: string | undefined,
): string | null {
  if (provider !== "custom") return BYOK_PROVIDER_BASE_URLS[provider];
  const raw = customBaseUrl?.trim() ?? "";
  if (raw.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password) return null;
  return parsed.toString().replace(/\/+$/, "");
}

export function parseStoredProviderKey(bytes: Uint8Array | null): StoredProviderKey | null {
  if (bytes === null || bytes.length === 0) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<StoredProviderKey>;
    if (typeof parsed.apiKey !== "string" || parsed.apiKey.length === 0) return null;
    if (typeof parsed.baseUrl !== "string" || parsed.baseUrl.length === 0) return null;
    return {
      apiKey: parsed.apiKey,
      baseUrl: parsed.baseUrl,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

function summaryOf(
  provider: ByokProviderId,
  stored: StoredProviderKey | null,
): AiProviderKeySummary {
  return {
    provider,
    configured: stored !== null,
    keyHint: stored ? secretKeyHint(stored.apiKey) : null,
    baseUrl: stored?.baseUrl ?? (provider === "custom" ? null : BYOK_PROVIDER_BASE_URLS[provider]),
    updatedAt: stored?.updatedAt || null,
  };
}

function describeHttpFailure(status: number): string {
  if (status === 401 || status === 403) return `The provider rejected the key (${status}).`;
  // xAI answers a wrong key with 400 "Incorrect API key provided".
  if (status === 400) return "The provider refused the request (400) — usually a wrong key.";
  if (status === 404) return "No /models endpoint at this base URL (404) — check the URL.";
  if (status === 429) return "The provider is rate-limiting this key (429). Try again shortly.";
  return `The provider answered ${status}.`;
}

/**
 * `GET {baseUrl}/models` with the key. Accepts OpenAI's `{data: [...]}` and a
 * bare array. Errors are ours — never the response body (it may echo the key).
 */
export async function fetchProviderModels(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<ProviderModelsResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${input.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${input.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(input.timeoutMs ?? MODELS_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      error: timedOut
        ? "The provider did not answer in time."
        : "Could not reach the provider — check the base URL and the network.",
    };
  }
  if (!response.ok) {
    return { ok: false, error: describeHttpFailure(response.status) };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: "The provider's /models answer is not JSON." };
  }
  const rows: ReadonlyArray<unknown> = Array.isArray(payload)
    ? payload
    : payload !== null &&
        typeof payload === "object" &&
        Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: ReadonlyArray<unknown> }).data
      : [];
  const models: Array<AssistantLlmModel> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = typeof record["id"] === "string" ? record["id"].trim() : "";
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const name =
      typeof record["display_name"] === "string" && record["display_name"].trim()
        ? record["display_name"].trim()
        : typeof record["name"] === "string" && record["name"].trim()
          ? record["name"].trim()
          : id;
    models.push({ id, name });
  }
  return { ok: true, models };
}

export const makeAiProviderKeys = (options?: { readonly fetchImpl?: typeof fetch }) =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore;

    const readStored = (provider: ByokProviderId) =>
      secretStore.get(secretNameForProvider(provider)).pipe(
        Effect.map(parseStoredProviderKey),
        Effect.orElseSucceed(() => null),
      );

    const list: AiProviderKeysShape["list"] = () =>
      Effect.forEach(BYOK_PROVIDER_IDS, (provider) =>
        readStored(provider).pipe(Effect.map((stored) => summaryOf(provider, stored))),
      );

    const set: AiProviderKeysShape["set"] = (input) =>
      Effect.gen(function* () {
        const apiKey = input.apiKey.trim();
        if (apiKey.length < 8 || /\s/.test(apiKey)) {
          return yield* new AiProviderKeyError({
            message: "That does not look like an API key.",
            status: 400,
          });
        }
        const baseUrl = resolveProviderBaseUrl(input.provider, input.baseUrl);
        if (baseUrl === null) {
          return yield* new AiProviderKeyError({
            message: "A custom provider needs an http(s) base URL, e.g. https://host/v1.",
            status: 400,
          });
        }
        const stored: StoredProviderKey = {
          apiKey,
          baseUrl,
          updatedAt: new Date().toISOString(),
        };
        yield* secretStore
          .set(
            secretNameForProvider(input.provider),
            new TextEncoder().encode(JSON.stringify(stored)),
          )
          .pipe(
            Effect.mapError(
              () => new AiProviderKeyError({ message: "Could not store the key.", status: 500 }),
            ),
          );
        yield* Effect.logInfo("aiProviders.key.stored", { provider: input.provider });
        return summaryOf(input.provider, stored);
      });

    const remove: AiProviderKeysShape["remove"] = (provider) =>
      secretStore.remove(secretNameForProvider(provider)).pipe(
        Effect.tap(() => Effect.logInfo("aiProviders.key.removed", { provider })),
        Effect.mapError(
          () => new AiProviderKeyError({ message: "Could not remove the key.", status: 500 }),
        ),
      );

    const resolve: AiProviderKeysShape["resolve"] = (provider) =>
      readStored(provider).pipe(
        Effect.map((stored) =>
          stored ? { apiKey: stored.apiKey, baseUrl: stored.baseUrl } : null,
        ),
      );

    const fetchModels = (baseUrl: string, apiKey: string) =>
      Effect.promise(() =>
        fetchProviderModels({
          baseUrl,
          apiKey,
          ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        }),
      );

    const test: AiProviderKeysShape["test"] = (input) =>
      Effect.gen(function* () {
        const stored = yield* readStored(input.provider);
        const apiKey = input.apiKey?.trim() || stored?.apiKey || "";
        if (apiKey.length === 0) {
          return { ok: false, modelCount: null, error: "No key to test — add one first." };
        }
        const baseUrl = input.baseUrl?.trim()
          ? resolveProviderBaseUrl(input.provider, input.baseUrl)
          : (stored?.baseUrl ?? resolveProviderBaseUrl(input.provider, undefined));
        if (baseUrl === null) {
          return {
            ok: false,
            modelCount: null,
            error: "A custom provider needs an http(s) base URL.",
          };
        }
        const result = yield* fetchModels(baseUrl, apiKey);
        return result.ok
          ? { ok: true, modelCount: result.models.length, error: null }
          : { ok: false, modelCount: null, error: result.error };
      });

    const listModels: AiProviderKeysShape["listModels"] = (provider) =>
      Effect.gen(function* () {
        const stored = yield* readStored(provider);
        if (stored === null) {
          return { ok: false, error: "No key stored for this provider." } as const;
        }
        return yield* fetchModels(stored.baseUrl, stored.apiKey);
      });

    return { list, set, remove, resolve, test, listModels } satisfies AiProviderKeysShape;
  });

export const AiProviderKeysLive = Layer.effect(AiProviderKeys, makeAiProviderKeys());

/** Test stub: an in-memory store (no keys unless seeded). */
export const AiProviderKeysTest = (
  seed: Partial<Record<ByokProviderId, ResolvedProviderKey>> = {},
) =>
  Layer.effect(
    AiProviderKeys,
    Effect.gen(function* () {
      const memory = new Map<string, Uint8Array>();
      for (const [provider, value] of Object.entries(seed)) {
        if (!value) continue;
        memory.set(
          secretNameForProvider(provider as ByokProviderId),
          new TextEncoder().encode(JSON.stringify({ ...value, updatedAt: "" })),
        );
      }
      return yield* makeAiProviderKeys().pipe(
        Effect.provideService(ServerSecretStore, {
          get: (name) => Effect.succeed(memory.get(name) ?? null),
          set: (name, value) => Effect.sync(() => void memory.set(name, value)),
          getOrCreateRandom: (name, bytes) =>
            Effect.sync(() => {
              const existing = memory.get(name);
              if (existing) return existing;
              const created = crypto.getRandomValues(new Uint8Array(bytes));
              memory.set(name, created);
              return created;
            }),
          remove: (name) => Effect.sync(() => void memory.delete(name)),
        }),
      );
    }),
  );
