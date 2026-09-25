import { describe, expect, it, vi } from "vitest";

import { __unoDriverTest } from "./provider/Drivers/UnoDriver.ts";
import {
  PersonalAiRequestError,
  fetchPersonalAiModels,
  normalizePersonalAiModel,
  personalAiAction,
} from "./unoPersonalAi.ts";

const QWEN = {
  id: "qwen3.8-27b-fp8",
  name: "Qwen 3.8 27B",
  catalog: true,
  size: "l",
  context_tokens: 120000,
  price_usd_per_hour: 6,
  idle_sleep_s: 60,
  state: "starting",
  eta_s: 240,
  started_at: "2026-09-23T20:00:00Z",
  steps: [
    { id: "node", label: "Starting GPU node", state: "done" },
    { id: "weights", label: "Loading model weights", state: "active" },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Personal AI client", () => {
  it("normalizes a backend row", () => {
    expect(normalizePersonalAiModel(QWEN)).toEqual({
      id: "qwen3.8-27b-fp8",
      name: "Qwen 3.8 27B",
      catalog: true,
      size: "l",
      contextTokens: 120000,
      priceUsdPerHour: 6,
      idleSleepS: 60,
      state: "starting",
      etaS: 240,
      startedAt: "2026-09-23T20:00:00Z",
      steps: QWEN.steps,
    });
    expect(normalizePersonalAiModel({ id: "x", state: "weird" })?.state).toBe("off");
    expect(normalizePersonalAiModel({ name: "no id" })).toBeUndefined();
  });

  it("lists models with the gateway key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { models: [QWEN] }));
    const result = await fetchPersonalAiModels("unollm_abc", fetchImpl);
    expect(result.available).toBe(true);
    expect(result.models.map((m) => m.id)).toEqual(["qwen3.8-27b-fp8"]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gpu.uno4.dev/personal/models");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer unollm_abc");
  });

  it("treats no access as 'option not available', not an error", async () => {
    const forbidden = vi.fn(async () => jsonResponse(403, { error: "FEATURE_DISABLED" }));
    await expect(fetchPersonalAiModels("unollm_abc", forbidden)).resolves.toEqual({
      available: false,
      models: [],
    });
    const never = vi.fn();
    await expect(fetchPersonalAiModels("", never)).resolves.toEqual({
      available: false,
      models: [],
    });
    expect(never).not.toHaveBeenCalled();
  });

  it("starts a model and explains a refusal in plain words", async () => {
    const ok = vi.fn(async () => jsonResponse(200, { ...QWEN, state: "starting" }));
    await expect(personalAiAction("k", "qwen3.8-27b-fp8", "start", ok)).resolves.toMatchObject({
      state: "starting",
    });
    expect((ok.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://gpu.uno4.dev/personal/models/qwen3.8-27b-fp8/start",
    );

    const broke = vi.fn(async () =>
      jsonResponse(402, { error: "INSUFFICIENT_BALANCE", detail: "top up" }),
    );
    const error = await personalAiAction("k", "qwen3.8-27b-fp8", "start", broke).catch((e) => e);
    expect(error).toBeInstanceOf(PersonalAiRequestError);
    expect(error.code).toBe("INSUFFICIENT_BALANCE");
    expect(error.message).toMatch(/Top up/);
  });
});

describe("UnoDriver Personal AI provider", () => {
  const personal = normalizePersonalAiModel(QWEN)!;

  it("adds the Personal AI provider with quiet warm-up only when models exist", () => {
    const withPersonal = JSON.parse(
      __unoDriverTest.buildUnoConfigContent("uno-key", {}, undefined, [personal]),
    ) as {
      provider: Record<
        string,
        { name: string; options: Record<string, unknown>; models: Record<string, unknown> }
      >;
    };
    const provider = withPersonal.provider["uno-personal"]!;
    expect(provider.name).toBe("Personal AI");
    expect(provider.options.baseURL).toBe("https://gpu.uno4.dev/v1");
    expect(provider.options.apiKey).toBe("{env:UNO_API_KEY}");
    expect(provider.options.headers).toEqual({ "X-Uno-Warmup": "quiet" });
    expect(provider.models).toEqual({ "qwen3.8-27b-fp8": { name: "Qwen 3.8 27B" } });

    const without = JSON.parse(__unoDriverTest.buildUnoConfigContent("uno-key", {})) as {
      provider: Record<string, unknown>;
    };
    expect(without.provider["uno-personal"]).toBeUndefined();
  });

  it("labels personal models with hourly price and sorts them after token models", () => {
    const personalCatalog = __unoDriverTest.personalCatalogBySlug([personal]);
    const draft = {
      models: [
        { slug: "uno-personal/qwen3.8-27b-fp8", name: "qwen3.8-27b-fp8", capabilities: {} },
        { slug: "uno/openai/gpt-5.5", name: "GPT-5.5", capabilities: {} },
      ],
    } as never;
    const decorated = __unoDriverTest.sortUnoModels({})(
      __unoDriverTest.withCatalogMetadata({}, personalCatalog)(draft),
    ) as unknown as {
      models: Array<{
        slug: string;
        name: string;
        subProvider?: string;
        capabilities: { metadata?: Record<string, unknown> };
      }>;
    };
    expect(decorated.models.map((m) => m.slug)).toEqual([
      "uno/openai/gpt-5.5",
      "uno-personal/qwen3.8-27b-fp8",
    ]);
    const row = decorated.models[1]!;
    expect(row.name).toBe("Qwen 3.8 27B");
    expect(row.subProvider).toBe("Personal AI");
    expect(row.capabilities.metadata).toMatchObject({
      pricing: { perHourUsd: 6 },
      personal: { idleSleepS: 60, size: "l" },
      supports: { tools: true },
    });
  });
});
