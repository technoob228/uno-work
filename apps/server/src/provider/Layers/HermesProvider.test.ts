import { describe, expect, it } from "vitest";

import type { UnoCatalogModel } from "../Drivers/UnoDriver.ts";
import {
  buildHermesModels,
  isHermesPickerModel,
  parseHermesVersionOutput,
} from "./HermesProvider.ts";

function catalogModel(overrides: Partial<UnoCatalogModel> & { modelId: string }): UnoCatalogModel {
  return {
    name: overrides.modelId,
    tier: "cheap",
    route: "default",
    availableRoutes: ["default"],
    provider: overrides.modelId.split("/")[0] ?? "unknown",
    contextLength: undefined,
    supportsStreaming: undefined,
    supportsTools: undefined,
    supportsVision: undefined,
    supportsImageOutput: undefined,
    inputModalities: undefined,
    outputModalities: undefined,
    pricingKnown: undefined,
    pricing: {
      promptPer1MUsd: undefined,
      completionPer1MUsd: undefined,
      blendedPer1MUsd: undefined,
      estimatedSeriousTaskUsd: undefined,
    },
    ...overrides,
  };
}

describe("parseHermesVersionOutput", () => {
  it("extracts the semver from `hermes acp --version`", () => {
    expect(
      parseHermesVersionOutput({ stdout: "Hermes ACP Adapter v0.18.0\n", stderr: "", code: 0 }),
    ).toEqual({ version: "0.18.0", status: "ready" });
  });

  it("degrades to error on unparseable failure output", () => {
    const parsed = parseHermesVersionOutput({ stdout: "", stderr: "boom", code: 1 });
    expect(parsed.status).toBe("error");
    expect(parsed.version).toBeNull();
  });
});

describe("isHermesPickerModel", () => {
  it("keeps agentic vendors and drops the rest of the 1000+ gateway catalog", () => {
    expect(isHermesPickerModel(catalogModel({ modelId: "anthropic/claude-haiku-4.5" }))).toBe(true);
    expect(isHermesPickerModel(catalogModel({ modelId: "deepseek/deepseek-v4-flash" }))).toBe(true);
    expect(isHermesPickerModel(catalogModel({ modelId: "aion-labs/aion-1.0" }))).toBe(false);
    expect(isHermesPickerModel(catalogModel({ modelId: "anthracite-org/magnum-v4-72b" }))).toBe(
      false,
    );
  });

  it("drops tool-less and non-text models", () => {
    expect(
      isHermesPickerModel(
        catalogModel({ modelId: "openai/gpt-image-1", supportsTools: false }),
      ),
    ).toBe(false);
    expect(
      isHermesPickerModel(
        catalogModel({ modelId: "openai/sora-x", outputModalities: ["video"] }),
      ),
    ).toBe(false);
  });
});

describe("buildHermesModels", () => {
  it("sorts by tier, dedupes and always includes the fallback default", () => {
    const models = buildHermesModels([
      catalogModel({ modelId: "deepseek/deepseek-v4-flash", tier: "cheap" }),
      catalogModel({ modelId: "anthropic/claude-fable-5", tier: "frontier" }),
      catalogModel({ modelId: "openai/gpt-5.5", tier: "strong" }),
      catalogModel({ modelId: "openai/gpt-5.5", tier: "strong" }),
    ]);
    expect(models.map((model) => model.slug)).toEqual([
      "anthropic/claude-fable-5",
      "openai/gpt-5.5",
      "deepseek/deepseek-v4-flash",
      // Дефолт драйвера дописывается в конец, когда его нет в каталоге.
      "anthropic/claude-haiku-4.5",
    ]);
  });

  it("returns only the fallback default on an empty catalog", () => {
    expect(buildHermesModels([]).map((model) => model.slug)).toEqual([
      "anthropic/claude-haiku-4.5",
    ]);
  });
});
