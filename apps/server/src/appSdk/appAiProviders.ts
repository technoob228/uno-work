/**
 * Where an app's answers come from (contracts: `AppAiProviderChoice`):
 * the Uno AI gateway, an OpenAI-compatible server on this computer (Ollama,
 * LM Studio, vLLM, llama.cpp…), Personal AI on the account's GPU, or a key
 * the person brought (Settings → Agents). The App API proxies to the chosen
 * one, so the app's code — and its SDK calls — stay the same.
 *
 * Kept free of Effect: probing and route resolution are plain functions over
 * injected fetch / key readers, tested with fakes.
 */
import {
  AI_PROVIDER_LABELS,
  type AiProviderKeySummary,
  type AppAiProviderChoice,
  type AppAiProviders,
  type ByokProviderId,
  type LocalAiEndpoint,
  UNO_PERSONAL_AI_BASE_URL,
} from "@t3tools/contracts";

/** OpenAI-compatible servers people run on their own machine, by their usual port. */
export const LOCAL_AI_CANDIDATES: ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly port: number;
}> = [
  { id: "ollama", label: "Ollama", port: 11434 },
  { id: "lmstudio", label: "LM Studio", port: 1234 },
  { id: "vllm", label: "vLLM", port: 8000 },
  { id: "llamacpp", label: "llama.cpp", port: 8080 },
  { id: "jan", label: "Jan", port: 1337 },
  { id: "textgen", label: "text-generation-webui", port: 5000 },
  { id: "sglang", label: "SGLang", port: 30000 },
];

/** `owned_by` of `/v1/models` → a truer name than the port guess. */
const OWNER_LABELS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^llamacpp$/i, "llamacpp", "llama.cpp"],
  [/^vllm$/i, "vllm", "vLLM"],
  [/^library$/i, "ollama", "Ollama"],
  [/^sglang$/i, "sglang", "SGLang"],
];

const PROBE_TIMEOUT_MS = 900;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * `http://127.0.0.1:11434/v1` style: http(s), no credentials, no query, no
 * trailing slash. A bare `host:port` gets `http://` and `/v1`. Null: unusable.
 */
export function normalizeLocalBaseUrl(raw: string): string | null {
  let text = raw.trim();
  if (text.length === 0) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "") pathname = "/v1";
  return `${url.protocol}//${url.host}${pathname}`;
}

/** Model ids of an OpenAI `/models` answer (`{data:[{id}]}` or a bare array); null: not that shape. */
export function parseModelIds(payload: unknown): { ids: string[]; owner: string | null } | null {
  const rows = Array.isArray(payload)
    ? payload
    : payload !== null &&
        typeof payload === "object" &&
        Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null;
  if (rows === null) return null;
  const ids: string[] = [];
  let owner: string | null = null;
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record["id"] === "string" && record["id"].trim()) ids.push(record["id"].trim());
    if (owner === null && typeof record["owned_by"] === "string") owner = record["owned_by"];
  }
  return { ids: [...new Set(ids)], owner };
}

export async function probeOpenAiEndpoint(
  baseUrl: string,
  options: {
    readonly fetch?: FetchLike;
    readonly timeoutMs?: number;
    readonly apiKey?: string;
  } = {},
): Promise<{ ids: string[]; owner: string | null } | null> {
  const fetchImpl = options.fetch ?? fetch;
  try {
    const response = await fetchImpl(`${baseUrl}/models`, {
      headers: {
        accept: "application/json",
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return parseModelIds(await response.json());
  } catch {
    return null;
  }
}

/**
 * Look for AI servers on this computer: the usual ports (loopback only) plus
 * the base URLs apps already use. A server that answers `/v1/models` in the
 * OpenAI shape counts — a random web app on :8080 doesn't.
 */
export async function detectLocalAi(
  options: {
    readonly fetch?: FetchLike;
    readonly host?: string;
    readonly extraBaseUrls?: ReadonlyArray<string>;
    readonly candidates?: typeof LOCAL_AI_CANDIDATES;
    /** Ports that are ours (the App API) and never an AI server. */
    readonly skipPorts?: ReadonlyArray<number>;
  } = {},
): Promise<LocalAiEndpoint[]> {
  const host = options.host ?? "127.0.0.1";
  const skip = new Set(options.skipPorts ?? []);
  const auto = (options.candidates ?? LOCAL_AI_CANDIDATES)
    .filter((c) => !skip.has(c.port))
    .map((c) => ({
      id: c.id,
      label: c.label,
      port: c.port,
      baseUrl: `http://${host}:${c.port}/v1`,
      detected: true,
    }));
  const autoUrls = new Set(auto.map((c) => c.baseUrl));
  const manual = [...new Set(options.extraBaseUrls ?? [])]
    .flatMap((raw) => normalizeLocalBaseUrl(raw) ?? [])
    .filter((url) => !autoUrls.has(url))
    .map((baseUrl) => ({
      id: "manual",
      label: labelForUrl(baseUrl),
      port: 0,
      baseUrl,
      detected: false,
    }));
  const probeOptions = options.fetch ? { fetch: options.fetch } : {};
  const results = await Promise.all(
    [...auto, ...manual].map(async (candidate) => ({
      candidate,
      found: await probeOpenAiEndpoint(candidate.baseUrl, probeOptions),
    })),
  );
  const out: LocalAiEndpoint[] = [];
  for (const { candidate, found } of results) {
    if (candidate.detected && !found) continue;
    const owner = found?.owner ? OWNER_LABELS.find(([re]) => re.test(found.owner ?? "")) : null;
    out.push({
      id: owner?.[1] ?? candidate.id,
      label: owner?.[2] ?? candidate.label,
      baseUrl: candidate.baseUrl,
      models: found?.ids ?? [],
      detected: candidate.detected,
      reachable: found !== null,
    });
  }
  return out;
}

function labelForUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const port = Number(url.port);
    const known = LOCAL_AI_CANDIDATES.find((c) => c.port === port);
    return known ? known.label : url.host;
  } catch {
    return baseUrl;
  }
}

/** The OpenAI-compatible place a call goes to, and whether it spends Uno AI. */
export interface AppAiRoute {
  readonly kind: AppAiProviderChoice["kind"];
  readonly baseUrl: string;
  /** Null: the server wants none (a local server). */
  readonly apiKey: string | null;
  readonly headers: Readonly<Record<string, string>>;
  /** Counts against the app's limit (only the Uno gateway). */
  readonly metered: boolean;
  /** The model for `"default"`; null → ask the provider and take the first. */
  readonly defaultModel: string | null;
  /** "Ollama on this computer", "OpenRouter (your key)" — for errors and Settings. */
  readonly label: string;
}

export type AppAiRouteResult =
  | { readonly ok: true; readonly route: AppAiRoute }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

export interface AppAiRouteDeps {
  readonly gateway: () => Promise<{ readonly baseUrl: string; readonly key: string } | null>;
  readonly gatewayChatModel: () => Promise<string>;
  readonly byokKey: (
    provider: ByokProviderId,
  ) => Promise<{ readonly apiKey: string; readonly baseUrl: string } | null>;
}

export const NOT_CONNECTED_MESSAGE =
  "This computer has no Uno AI connected yet. Sign in to Uno in Uno Work to turn it on.";

const modelOf = (choice: AppAiProviderChoice) =>
  typeof choice.model === "string" && choice.model.trim() ? choice.model.trim() : null;

/** What a stored choice means right now (keys resolved, gateway connected or not). */
export async function resolveAppAiRoute(
  choice: AppAiProviderChoice | null,
  deps: AppAiRouteDeps,
): Promise<AppAiRouteResult> {
  const kind = choice?.kind ?? "uno";
  if (kind === "local") {
    const baseUrl = normalizeLocalBaseUrl(choice?.baseUrl ?? "");
    if (!baseUrl) {
      return {
        ok: false,
        status: 503,
        code: "provider_not_configured",
        message:
          "This app is set to use AI on this computer, but no server address is set. Pick one in Uno Work → Settings → Apps.",
      };
    }
    return {
      ok: true,
      route: {
        kind,
        baseUrl,
        apiKey: null,
        headers: {},
        metered: false,
        defaultModel: choice ? modelOf(choice) : null,
        label: `${labelForUrl(baseUrl)} on this computer`,
      },
    };
  }
  if (kind === "byok") {
    const provider = choice?.keyProvider ?? "custom";
    const key = await deps.byokKey(provider);
    if (!key) {
      return {
        ok: false,
        status: 503,
        code: "provider_not_configured",
        message: `This app is set to use your ${AI_PROVIDER_LABELS[provider]} key, but none is stored. Add it in Uno Work → Settings → Agents, or pick another provider in Settings → Apps.`,
      };
    }
    return {
      ok: true,
      route: {
        kind,
        baseUrl: key.baseUrl.replace(/\/+$/, ""),
        apiKey: key.apiKey,
        headers: {},
        metered: false,
        defaultModel: choice ? modelOf(choice) : null,
        label: `${AI_PROVIDER_LABELS[provider]} (your key)`,
      },
    };
  }
  const gateway = await deps.gateway();
  if (!gateway) {
    return { ok: false, status: 503, code: "ai_not_connected", message: NOT_CONNECTED_MESSAGE };
  }
  if (kind === "personal") {
    return {
      ok: true,
      route: {
        kind,
        baseUrl: `${UNO_PERSONAL_AI_BASE_URL}/v1`,
        apiKey: gateway.key,
        // Warm-up progress as SSE comments, never as the model's words.
        headers: { "X-Uno-Warmup": "quiet" },
        metered: false,
        defaultModel: choice ? modelOf(choice) : null,
        label: "Personal AI (your GPU)",
      },
    };
  }
  return {
    ok: true,
    route: {
      kind: "uno",
      baseUrl: gateway.baseUrl,
      apiKey: gateway.key,
      headers: {},
      metered: true,
      defaultModel: (choice ? modelOf(choice) : null) ?? (await deps.gatewayChatModel()),
      label: "Uno AI",
    },
  };
}

/** "Uno AI · deepseek/deepseek-v3.2" — the line Settings and the agent brief show. */
export function describeChoice(
  choice: AppAiProviderChoice | null,
  providers: Pick<AppAiProviders, "local"> | null,
  gatewayChatModel: string,
): string {
  const kind = choice?.kind ?? "uno";
  const model = choice ? modelOf(choice) : null;
  const withModel = (label: string, fallback: string | null) =>
    (model ?? fallback) ? `${label} · ${model ?? fallback}` : label;
  if (kind === "local") {
    const base = normalizeLocalBaseUrl(choice?.baseUrl ?? "");
    const endpoint = providers?.local.find((e) => e.baseUrl === base);
    return withModel(
      `${endpoint?.label ?? (base ? labelForUrl(base) : "AI")} on this computer`,
      endpoint?.models[0] ?? null,
    );
  }
  if (kind === "byok") {
    return withModel(`${AI_PROVIDER_LABELS[choice?.keyProvider ?? "custom"]} (your key)`, null);
  }
  if (kind === "personal") return withModel("Personal AI (your GPU)", null);
  return withModel("Uno AI", gatewayChatModel);
}

/** A stored choice, cleaned: unknown kinds → null (Uno AI). */
export function normalizeProviderChoice(raw: unknown): AppAiProviderChoice | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const kind = record["kind"];
  const model =
    typeof record["model"] === "string" && record["model"].trim() ? record["model"].trim() : null;
  if (kind === "local") {
    const baseUrl =
      typeof record["baseUrl"] === "string" ? normalizeLocalBaseUrl(record["baseUrl"]) : null;
    return baseUrl ? { kind, baseUrl, model } : null;
  }
  if (kind === "byok") {
    const provider = record["keyProvider"];
    if (
      provider !== "xai" &&
      provider !== "openrouter" &&
      provider !== "openai" &&
      provider !== "custom"
    ) {
      return null;
    }
    return { kind, keyProvider: provider, model };
  }
  if (kind === "personal") return { kind, model };
  if (kind === "uno") return model ? { kind, model } : null;
  return null;
}

/**
 * `~/.uno/ai-providers.md` — what an agent on this computer reads to know,
 * right now, which AI an app could use (never a key; keys are only named).
 */
export function renderProvidersBrief(input: {
  readonly providers: AppAiProviders;
  readonly apps: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly label: string;
  }>;
  readonly apiUrl: string | null;
  readonly now?: Date;
}): string {
  const { providers } = input;
  const lines: string[] = [
    "# AI that apps on this computer can use",
    "",
    `Updated ${(input.now ?? new Date()).toISOString()} by Uno Work. An app calls the App API (${input.apiUrl ?? "http://127.0.0.1:3779"}) with its own token; the person picks each app's provider in Uno Work → Settings → Apps. App code never changes with the provider — always send "model": "default" unless the person asked for a specific model.`,
    "",
    "## Providers",
    "",
    `- **Uno AI** (default) — ${providers.unoConnected ? "connected" : "NOT connected (sign in to Uno in Uno Work)"}. Metered: counts against the app's limit.`,
  ];
  const reachable = providers.local.filter((e) => e.reachable);
  if (reachable.length === 0) {
    lines.push(
      "- **AI on this computer** — none running. Ollama (:11434), LM Studio (:1234), vLLM (:8000), llama.cpp (:8080) are found by themselves when started.",
    );
  } else {
    for (const endpoint of reachable) {
      const models = endpoint.models.slice(0, 12).join(", ") || "no models loaded";
      lines.push(
        `- **${endpoint.label} on this computer** — ${endpoint.baseUrl} · models: ${models}. Free, no limit.`,
      );
    }
  }
  if (providers.personal.length > 0) {
    lines.push(
      `- **Personal AI (the account's GPU)** — ${providers.personal.map((m) => `${m.name} ($${m.priceUsdPerHour}/h while on)`).join(", ")}.`,
    );
  }
  const keys = providers.keys.filter((k) => k.configured);
  lines.push(
    keys.length > 0
      ? `- **The person's own keys** — ${keys.map((k: AiProviderKeySummary) => AI_PROVIDER_LABELS[k.provider]).join(", ")} (billed by that provider).`
      : "- **The person's own keys** — none stored (Settings → Agents → AI provider keys).",
  );
  lines.push("", "## Apps and what they use now", "");
  if (input.apps.length === 0) lines.push("- (no app uses AI yet)");
  for (const app of input.apps) lines.push(`- \`${app.id}\` (${app.name}) → ${app.label}`);
  lines.push(
    "",
    "Never switch an app's provider yourself and never put a provider key into an app: tell the person to pick it in Settings → Apps.",
    "",
  );
  return lines.join("\n");
}
