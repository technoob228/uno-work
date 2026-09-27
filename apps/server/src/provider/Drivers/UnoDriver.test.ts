import { afterEach, describe, expect, it, vi } from "vitest";

import { __unoDriverTest, fetchUnoModelsCatalogWithRetry } from "./UnoDriver.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UnoDriver catalog normalization", () => {
  it("normalizes optional gateway metadata and computes pricing estimates", () => {
    const model = __unoDriverTest.normalizeUnoCatalogEntry("default", {
      id: "openai/gpt-5.5",
      display_name: "GPT-5.5",
      owned_by: "openai",
      tier: "frontier",
      context_length: 400_000,
      supports_streaming: true,
      supports_tools: true,
      supports_vision: true,
      pricing_known: true,
      pricing: {
        prompt: "0.00000125",
        completion: "0.000010",
      },
    });

    expect(model).toMatchObject({
      name: "GPT-5.5",
      tier: "frontier",
      modelId: "openai/gpt-5.5",
      route: "default",
      availableRoutes: ["default"],
      provider: "openai",
      contextLength: 400_000,
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: true,
      pricingKnown: true,
      pricing: {
        promptPer1MUsd: 1.25,
        completionPer1MUsd: 10,
        blendedPer1MUsd: 2.5625,
      },
    });
    expect(model?.pricing.estimatedSeriousTaskUsd).toBeCloseTo(0.23);
  });

  it("tolerates missing optional fields", () => {
    const model = __unoDriverTest.normalizeUnoCatalogEntry("russia", {
      id: "moonshotai/kimi-k2",
    });

    expect(model).toMatchObject({
      name: "moonshotai/kimi-k2",
      tier: "cheap",
      route: "russia",
      provider: "moonshotai",
      pricing: {},
    });
  });

  it("maps gateway image modalities into model metadata", () => {
    const model = __unoDriverTest.normalizeUnoCatalogEntry("default", {
      id: "openai/gpt-image-1",
      display_name: "GPT Image 1",
      tier: "strong",
      supports_streaming: "false",
      supports_tools: true,
      modalities: {
        input: ["text", "image"],
        output: ["image"],
      },
    });

    expect(model).toMatchObject({
      supportsStreaming: false,
      supportsTools: true,
      supportsVision: true,
      supportsImageOutput: true,
      inputModalities: ["text", "image"],
      outputModalities: ["image"],
    });

    expect(__unoDriverTest.metadataForCatalogModel(model!)).toMatchObject({
      supports: { tools: true, vision: true, attachments: true },
      modalities: {
        input: ["text", "image"],
        output: ["image"],
      },
    });
  });

  it("adds a hidden no-tools agent for image-generation models", () => {
    const config = JSON.parse(__unoDriverTest.buildUnoConfigContent("uno-key", {})) as {
      readonly agent?: Record<string, unknown>;
    };

    expect(config.agent?.["uno-image-generation"]).toMatchObject({
      mode: "primary",
      hidden: true,
      permission: {
        "*": "deny",
      },
    });
  });

  it("never forces a reasoning effort on gateway models", () => {
    // `reasoningEffort: "none"` made Grok 4.7 / GLM-5.3 fail with HTTP 400
    // "Reasoning is mandatory" and made Fast narrate its plan in the answer.
    const ids = [
      ["openai/gpt-5.5", "GPT-5.5"],
      ["moonshotai/kimi-k2.6", "Kimi K2.6"],
      ["x-ai/grok-4.7", "Grok 4.7"],
      ["z-ai/glm-5.3", "GLM-5.3"],
      ["uno/fast", "Fast"],
      ["anthropic/claude-fable-5", "Claude Fable 5"],
    ] as const;
    const catalog = Object.fromEntries(
      ids.map(([id, name]) => {
        const entry = __unoDriverTest.normalizeUnoCatalogEntry("default", {
          id,
          display_name: name,
        });
        expect(entry).not.toBeNull();
        return [`uno/${id}`, entry!];
      }),
    );

    const config = JSON.parse(__unoDriverTest.buildUnoConfigContent("uno-key", catalog)) as {
      readonly enabled_providers?: ReadonlyArray<string>;
      readonly provider?: {
        readonly uno?: { readonly models?: Record<string, Record<string, unknown>> };
      };
    };

    const models = config.provider?.uno?.models ?? {};
    expect(Object.keys(models).toSorted()).toEqual(ids.map(([id]) => id).toSorted());
    for (const [id, name] of ids) {
      expect(models[id]).toEqual({ name });
    }
    // Only the Uno providers reach the harness (no OpenCode Zen / models.dev).
    expect(config.enabled_providers).toEqual(["uno", "uno-russia"]);
  });

  it("uses conservative fallbacks for known vision and image-generation model families", () => {
    const gemini = __unoDriverTest.normalizeUnoCatalogEntry("default", {
      id: "google/gemini-3.1-pro-preview",
      display_name: "Gemini 3.1 Pro Preview",
    });
    const imagen = __unoDriverTest.normalizeUnoCatalogEntry("default", {
      id: "google/imagen-4",
      display_name: "Imagen 4",
    });
    const gptImage = __unoDriverTest.normalizeUnoCatalogEntry("default", {
      id: "openai/gpt-5-image-mini",
      display_name: "GPT-5 Image Mini",
    });
    const nanoBanana = __unoDriverTest.normalizeUnoCatalogEntry("default", {
      id: "google/nano-banana-pro",
      display_name: "Nano Banana Pro (Gemini 3 Pro Image Preview)",
    });

    expect(__unoDriverTest.metadataForCatalogModel(gemini!).modalities?.input).toContain("image");
    expect(__unoDriverTest.metadataForCatalogModel(imagen!).modalities?.output).toContain("image");
    expect(__unoDriverTest.metadataForCatalogModel(gptImage!).modalities?.output).toContain(
      "image",
    );
    expect(__unoDriverTest.metadataForCatalogModel(nanoBanana!).modalities?.output).toContain(
      "image",
    );
  });

  it("fetches global and Russia catalogs, tolerates a failed route, and annotates shared routes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return new Response(
          JSON.stringify({
            data: [
              { id: "openai/gpt-5.5", display_name: "GPT-5.5", tier: "frontier" },
              { id: "cheap/model", display_name: "Cheap Model", tier: "cheap" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/v1/russia/models")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "openai/gpt-5.5", display_name: "GPT-5.5 RU", tier: "frontier" }],
          }),
          { status: 200 },
        );
      }
      return new Response("", { status: 404 });
    });

    const catalog = await __unoDriverTest.fetchUnoModelsCatalog("uno-key");

    expect(catalog["uno/openai/gpt-5.5"]?.availableRoutes).toEqual(["default", "russia"]);
    expect(catalog["uno-russia/openai/gpt-5.5"]?.availableRoutes).toEqual(["default", "russia"]);
    expect(catalog["uno/cheap/model"]?.availableRoutes).toEqual(["default"]);
  });

  it("keeps the healthy route when the other route fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return new Response(
          JSON.stringify({ data: [{ id: "openai/gpt-5.5", tier: "frontier" }] }),
          { status: 200 },
        );
      }
      throw new Error("route unavailable");
    });

    const catalog = await __unoDriverTest.fetchUnoModelsCatalog("uno-key");

    expect(Object.keys(catalog)).toEqual(["uno/openai/gpt-5.5"]);
  });

  it("retries the catalog when the first attempts fail (fresh box, network not up yet)", async () => {
    let calls = 0;
    const failures: number[] = [];
    const catalog = await fetchUnoModelsCatalogWithRetry("unollm_key", {
      delaysMs: [0, 0, 0],
      fetchCatalog: async () => {
        calls += 1;
        if (calls < 3) throw new Error("fetch failed");
        return { "uno/openai/gpt-5.5": {} as never };
      },
      onAttemptFailed: (attempt) => failures.push(attempt),
    });
    expect(Object.keys(catalog)).toEqual(["uno/openai/gpt-5.5"]);
    expect(failures).toEqual([1, 2]);
  });

  it("an empty answer is a failed attempt, and giving up returns an empty catalog", async () => {
    let calls = 0;
    const catalog = await fetchUnoModelsCatalogWithRetry("unollm_key", {
      delaysMs: [0, 0],
      fetchCatalog: async () => {
        calls += 1;
        return {};
      },
    });
    expect(catalog).toEqual({});
    expect(calls).toBe(2);
  });

  it("no key — no requests", async () => {
    let calls = 0;
    const catalog = await fetchUnoModelsCatalogWithRetry("", {
      fetchCatalog: async () => {
        calls += 1;
        return {};
      },
    });
    expect(catalog).toEqual({});
    expect(calls).toBe(0);
  });

  it("sorts pinned models, then frontier, strong, and cheap tiers", () => {
    const unknownPricing = {
      promptPer1MUsd: undefined,
      completionPer1MUsd: undefined,
      blendedPer1MUsd: undefined,
      estimatedSeriousTaskUsd: undefined,
    };
    const snapshot = {
      models: [
        { slug: "uno/cheap/model", name: "Cheap", isCustom: false },
        { slug: "uno/anthropic/claude-opus-4.7", name: "Pinned", isCustom: false },
        { slug: "uno/strong/model", name: "Strong", isCustom: false },
        { slug: "uno/frontier/model", name: "Frontier", isCustom: false },
      ],
    };
    const sorted = __unoDriverTest.sortUnoModels({
      "uno/cheap/model": {
        name: "Cheap",
        tier: "cheap",
        modelId: "cheap/model",
        route: "default",
        availableRoutes: ["default"],
        provider: "cheap",
        contextLength: undefined,
        supportsStreaming: undefined,
        supportsTools: undefined,
        supportsVision: undefined,
        supportsImageOutput: undefined,
        inputModalities: undefined,
        outputModalities: undefined,
        pricingKnown: undefined,
        pricing: unknownPricing,
      },
      "uno/anthropic/claude-opus-4.7": {
        name: "Pinned",
        tier: "frontier",
        modelId: "anthropic/claude-opus-4.7",
        route: "default",
        availableRoutes: ["default"],
        provider: "anthropic",
        contextLength: undefined,
        supportsStreaming: undefined,
        supportsTools: undefined,
        supportsVision: undefined,
        supportsImageOutput: undefined,
        inputModalities: undefined,
        outputModalities: undefined,
        pricingKnown: undefined,
        pricing: unknownPricing,
      },
      "uno/strong/model": {
        name: "Strong",
        tier: "strong",
        modelId: "strong/model",
        route: "default",
        availableRoutes: ["default"],
        provider: "strong",
        contextLength: undefined,
        supportsStreaming: undefined,
        supportsTools: undefined,
        supportsVision: undefined,
        supportsImageOutput: undefined,
        inputModalities: undefined,
        outputModalities: undefined,
        pricingKnown: undefined,
        pricing: unknownPricing,
      },
      "uno/frontier/model": {
        name: "Frontier",
        tier: "frontier",
        modelId: "frontier/model",
        route: "default",
        availableRoutes: ["default"],
        provider: "frontier",
        contextLength: undefined,
        supportsStreaming: undefined,
        supportsTools: undefined,
        supportsVision: undefined,
        supportsImageOutput: undefined,
        inputModalities: undefined,
        outputModalities: undefined,
        pricingKnown: undefined,
        pricing: unknownPricing,
      },
    })(snapshot as never);

    expect(sorted.models.map((model) => model.slug)).toEqual([
      "uno/anthropic/claude-opus-4.7",
      "uno/frontier/model",
      "uno/strong/model",
      "uno/cheap/model",
    ]);
  });
});

describe("UnoDriver with AI hours (curated catalog)", () => {
  const entry = (id: string, extra: Record<string, unknown> = {}) =>
    __unoDriverTest.normalizeUnoCatalogEntry("default", {
      id,
      supports_tools: true,
      ...extra,
    })!;
  const curated = {
    "uno/uno/fast": entry("uno/fast", {
      display_name: "Fast",
      uno_group: "included",
      underlying_model: "deepseek/deepseek-v4.1-flash",
    }),
    "uno/anthropic/claude-sonnet-5": entry("anthropic/claude-sonnet-5", {
      display_name: "Claude Sonnet 5",
      uno_group: "premium",
    }),
    "uno/uno/smart": entry("uno/smart", {
      display_name: "Smart",
      uno_group: "included",
      underlying_model: "xiaomi/mimo-v2.6-pro",
      description: "Best for most work.",
    }),
    "uno/anthropic/claude-opus-5.5": entry("anthropic/claude-opus-5.5", {
      display_name: "Claude Opus 5.5",
      uno_group: "premium",
    }),
  };

  it("reads uno_group, the real model behind Smart/Fast and the description", () => {
    const smart = curated["uno/uno/smart"];
    expect(smart.group).toBe("included");
    expect(smart.underlyingModel).toBe("MiMo-V2.6-Pro");
    const metadata = __unoDriverTest.metadataForCatalogModel(smart);
    expect(metadata.unoGroup).toBe("included");
    expect(metadata.underlyingModel).toBe("MiMo-V2.6-Pro");
    expect(metadata.description).toBe("Best for most work.");
    expect(entry("x/y").group).toBeUndefined();
  });

  it("sorts Smart, Fast, then premium in the fixed order, private GPU last", () => {
    const snapshot = {
      models: [
        { slug: "uno-personal/qwen", name: "Qwen", isCustom: false },
        { slug: "uno/anthropic/claude-sonnet-5", name: "Sonnet", isCustom: false },
        { slug: "uno/uno/fast", name: "Fast", isCustom: false },
        { slug: "uno/anthropic/claude-opus-5.5", name: "Opus", isCustom: false },
        { slug: "uno/uno/smart", name: "Smart", isCustom: false },
      ],
    };
    const sorted = __unoDriverTest.sortUnoModels(curated)(snapshot as never);
    expect(sorted.models.map((model) => model.slug)).toEqual([
      "uno/uno/smart",
      "uno/uno/fast",
      "uno/anthropic/claude-opus-5.5",
      "uno/anthropic/claude-sonnet-5",
      "uno-personal/qwen",
    ]);
  });

  it("hides unmarked and harness-only legacy models from the picker", () => {
    const snapshot = {
      models: [
        { slug: "uno/uno/smart", name: "Smart", isCustom: false },
        { slug: "uno/moonshotai/kimi-k2.7-code", name: "Smart", isCustom: false },
        { slug: "uno-personal/qwen", name: "Qwen", isCustom: false },
      ],
    };
    const filtered = __unoDriverTest.filterCuratedUnoModels(curated)(snapshot as never);
    expect(filtered.models.map((model) => model.slug)).toEqual([
      "uno/uno/smart",
      "uno-personal/qwen",
    ]);
    // An older gateway (no marks): nothing is hidden.
    const old = { "uno/x/y": entry("x/y") };
    expect(__unoDriverTest.filterCuratedUnoModels(old)(snapshot as never).models).toHaveLength(3);
  });

  it("keeps the legacy defaults in the harness config so saved chats still run", () => {
    const config = JSON.parse(__unoDriverTest.buildUnoConfigContent("key", curated)) as {
      provider: { uno: { models: Record<string, { name: string }> } };
    };
    expect(Object.keys(config.provider.uno.models)).toEqual(
      expect.arrayContaining([
        "uno/smart",
        "uno/fast",
        "moonshotai/kimi-k2.7-code",
        "~deepseek/deepseek-v4-flash-latest",
      ]),
    );
    const oldConfig = JSON.parse(
      __unoDriverTest.buildUnoConfigContent("key", { "uno/x/y": entry("x/y") }),
    ) as { provider: { uno: { models: Record<string, unknown> } } };
    expect(Object.keys(oldConfig.provider.uno.models)).toEqual(["x/y"]);
  });

  it("drops the vendor prefix from curated names and groups private GPU models", () => {
    const withMeta = __unoDriverTest.withCatalogMetadata(curated, {
      "uno-personal/mine": {
        id: "mine",
        name: "My model",
        catalog: false,
        size: "8B",
        priceUsdPerHour: 1,
        idleSleepS: 60,
        state: "off",
      },
    })({
      models: [
        { slug: "uno/uno/smart", name: "uno/smart", isCustom: false },
        { slug: "uno-personal/mine", name: "mine", isCustom: false },
      ],
    } as never);
    expect(withMeta.models[0]).toMatchObject({ name: "Smart" });
    expect(withMeta.models[0]!.subProvider).toBeUndefined();
    expect(withMeta.models[1]!.capabilities?.metadata?.unoGroup).toBe("custom");
  });
});
