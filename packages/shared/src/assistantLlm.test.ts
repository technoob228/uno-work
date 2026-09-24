import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  assistantModelLabel,
  assistantModelSelection,
  assistantProviderLabel,
  coerceAssistantModelSelection,
  DEFAULT_ASSISTANT_MODEL_SELECTION,
  defaultAssistantModelFor,
  harnessForAccountDefaultAi,
  pickLatestGrokModel,
  readAssistantLlmProvider,
  sameAssistantModelSelection,
  secretKeyHint,
} from "./assistantLlm.ts";

describe("assistant model selection", () => {
  it("defaults to Hermes, the latest Grok and the Uno gateway", () => {
    expect(DEFAULT_ASSISTANT_MODEL_SELECTION).toEqual({
      instanceId: "hermes",
      model: "~x-ai/grok-latest",
      options: [{ id: "llmProvider", value: "uno" }],
    });
  });

  it("reads the provider, falling back to the gateway", () => {
    expect(
      readAssistantLlmProvider(assistantModelSelection({ provider: "xai", model: "grok-4" })),
    ).toBe("xai");
    expect(readAssistantLlmProvider({ options: [{ id: "llmProvider", value: "bogus" }] })).toBe(
      "uno",
    );
    expect(readAssistantLlmProvider(null)).toBe("uno");
  });

  it("coerces another harness to the default and keeps a Hermes choice", () => {
    expect(
      coerceAssistantModelSelection({
        instanceId: ProviderInstanceId.make("uno"),
        model: "uno/moonshotai/kimi-k2.7-code",
      }),
    ).toEqual(DEFAULT_ASSISTANT_MODEL_SELECTION);
    const byok = assistantModelSelection({ provider: "openrouter", model: "x-ai/grok-4.7" });
    expect(coerceAssistantModelSelection(byok)).toEqual(byok);
    // A Hermes selection without the option is on the gateway.
    expect(
      coerceAssistantModelSelection({
        instanceId: ProviderInstanceId.make("hermes"),
        model: "x-ai/grok-4.6",
      }),
    ).toEqual(assistantModelSelection({ provider: "uno", model: "x-ai/grok-4.6" }));
  });

  it("compares harness, model and provider", () => {
    const a = assistantModelSelection({ provider: "uno", model: "x" });
    expect(
      sameAssistantModelSelection(a, assistantModelSelection({ provider: "uno", model: "x" })),
    ).toBe(true);
    expect(
      sameAssistantModelSelection(a, assistantModelSelection({ provider: "xai", model: "x" })),
    ).toBe(false);
  });
});

describe("latest Grok", () => {
  it("picks the newest plain release and ignores variants", () => {
    expect(
      pickLatestGrokModel([
        "x-ai/grok-4.20",
        "x-ai/grok-4.20-multi-agent",
        "x-ai/grok-4.3",
        "x-ai/grok-4.3:batch",
        "x-ai/grok-4.7",
        "x-ai/grok-build-0.1",
        "~x-ai/grok-latest",
        "openai/gpt-5",
      ]),
    ).toBe("x-ai/grok-4.7");
    expect(pickLatestGrokModel(["grok-4", "grok-4-0709", "grok-3-mini", "grok-4.1"])).toBe(
      "grok-4.1",
    );
    expect(pickLatestGrokModel(["gpt-5"])).toBeNull();
  });

  it("chooses a default per provider", () => {
    expect(defaultAssistantModelFor("uno", [])).toBe("~x-ai/grok-latest");
    expect(defaultAssistantModelFor("openrouter", ["~x-ai/grok-latest", "x-ai/grok-4.7"])).toBe(
      "~x-ai/grok-latest",
    );
    expect(defaultAssistantModelFor("xai", ["grok-4", "grok-4.7", "grok-3"])).toBe("grok-4.7");
    expect(defaultAssistantModelFor("openai", ["gpt-5", "gpt-4.1"])).toBe("gpt-5");
    expect(defaultAssistantModelFor("custom", [])).toBeNull();
  });
});

describe("labels", () => {
  it("names models and providers for the header", () => {
    expect(assistantModelLabel("~x-ai/grok-latest")).toBe("Grok (latest)");
    expect(assistantModelLabel("x-ai/grok-4.7")).toBe("Grok 4.7");
    expect(assistantModelLabel("openai/gpt-5")).toBe("gpt-5");
    expect(assistantProviderLabel("uno")).toBe("Uno gateway");
    expect(assistantProviderLabel("xai")).toBe("Your xAI key");
  });

  it("shows only the last four characters of a key", () => {
    expect(secretKeyHint("xai-abcdefghijklmnop1234")).toBe("1234");
    expect(secretKeyHint("abc")).toBe("••••");
  });
});

describe("account default AI", () => {
  it("maps the console's default_ai to a harness", () => {
    expect(harnessForAccountDefaultAi("claude")).toBe("claudeAgent");
    expect(harnessForAccountDefaultAi("byok")).toBe("opencode");
    expect(harnessForAccountDefaultAi("uno")).toBe("uno");
    expect(harnessForAccountDefaultAi("something")).toBeNull();
  });
});
