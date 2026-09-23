import { describe, expect, it } from "vitest";

import {
  GATEWAY_PROVIDER_COST_MARKUP,
  TRANSCRIPTION_MAX_USD,
  chatCostUsd,
  makeSseUsageTracker,
  parseModelPrices,
  transcriptionCostUsd,
  usageFromPayload,
} from "./pricing.ts";

describe("pricing", () => {
  it("prefers the billed cost, then the provider cost with markup, then token prices", () => {
    const price = { prompt: 0.001, completion: 0.002 };
    const billed = usageFromPayload({
      usage: { prompt_tokens: 10, cost: 1 },
      x_uno: { cost_usd: 0.5 },
    });
    expect(chatCostUsd(billed!, price)).toBe(0.5);
    const provider = usageFromPayload({ usage: { prompt_tokens: 10, cost: 1 } });
    expect(chatCostUsd(provider!, price)).toBe(GATEWAY_PROVIDER_COST_MARKUP);
    const tokens = usageFromPayload({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
    expect(chatCostUsd(tokens!, price)).toBeCloseTo(0.02, 10);
    expect(chatCostUsd(tokens!, undefined)).toBeGreaterThan(0);
  });

  it("reads usage from an SSE stream split at any byte", () => {
    const stream =
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}\n\ndata: [DONE]\n\n';
    for (const cut of [1, 7, 40, 70, stream.length - 3]) {
      const tracker = makeSseUsageTracker();
      tracker.push(stream.slice(0, cut));
      tracker.push(stream.slice(cut));
      const { usage, contentChars } = tracker.finish();
      expect(usage).toMatchObject({ promptTokens: 3, completionTokens: 4 });
      expect(contentChars).toBe(2);
    }
  });

  it("caps a transcription at what the gateway can bill", () => {
    expect(transcriptionCostUsd({ audioBytes: 500 * 1024 * 1024, durationSeconds: null })).toBe(
      TRANSCRIPTION_MAX_USD,
    );
    expect(transcriptionCostUsd({ audioBytes: 0, durationSeconds: 60 })).toBeCloseTo(0.0069, 6);
  });

  it("parses model prices and skips unknown ones", () => {
    const prices = parseModelPrices({
      data: [
        { id: "a", pricing: { prompt: "0.000001", completion: "0.000002" } },
        { id: "b", pricing: { prompt: null, completion: null } },
      ],
    });
    expect([...prices.keys()]).toEqual(["a"]);
  });
});
