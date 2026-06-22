import { afterEach, describe, expect, it, vi } from "vitest";

import { __unoDriverTest } from "./UnoDriver.ts";

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

  it("does not disable reasoning by default for mandatory-reasoning model families", () => {
    const openai = __unoDriverTest.normalizeUnoCatalogEntry("default", {
      id: "openai/gpt-5.5",
      display_name: "GPT-5.5",
    });
    const kimi = __unoDriverTest.normalizeUnoCatalogEntry("default", {
      id: "moonshotai/kimi-k2.6",
      display_name: "Kimi K2.6",
    });
    const thinking = __unoDriverTest.normalizeUnoCatalogEntry("default", {
      id: "qwen/qwen3-vl-235b-a22b-thinking",
      display_name: "Qwen3 VL Thinking",
    });

    expect(openai).not.toBeNull();
    expect(kimi).not.toBeNull();
    expect(thinking).not.toBeNull();

    const config = JSON.parse(
      __unoDriverTest.buildUnoConfigContent("uno-key", {
        "uno/openai/gpt-5.5": openai!,
        "uno/moonshotai/kimi-k2.6": kimi!,
        "uno/qwen/qwen3-vl-235b-a22b-thinking": thinking!,
      }),
    ) as {
      readonly provider?: {
        readonly uno?: {
          readonly models?: Record<
            string,
            { readonly options?: { readonly reasoningEffort?: string } }
          >;
        };
      };
    };

    const models = config.provider?.uno?.models ?? {};
    expect(models["openai/gpt-5.5"]?.options).toEqual({ reasoningEffort: "none" });
    expect(models["moonshotai/kimi-k2.6"]?.options).toBeUndefined();
    expect(models["qwen/qwen3-vl-235b-a22b-thinking"]?.options).toBeUndefined();
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
