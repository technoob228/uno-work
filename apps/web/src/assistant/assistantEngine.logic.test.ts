import type { AssistantLlmStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { assistantEngineNotice, assistantEngineSendBlock } from "./assistantEngine.logic";

const status = (overrides: Partial<AssistantLlmStatus> = {}): AssistantLlmStatus => ({
  threadId: "thread-uno",
  provider: "uno",
  model: "~x-ai/grok-latest",
  harness: { state: "ready", message: null, version: "0.18.0", logTail: null },
  keys: [
    {
      provider: "xai",
      configured: true,
      keyHint: "1234",
      baseUrl: "https://api.x.ai/v1",
      updatedAt: null,
    },
    { provider: "openai", configured: false, keyHint: null, baseUrl: null, updatedAt: null },
  ],
  gatewayConfigured: true,
  ...overrides,
});

describe("assistant engine notice", () => {
  it("says nothing when Hermes is ready on the gateway", () => {
    expect(assistantEngineNotice(status())).toBeNull();
    expect(assistantEngineSendBlock(status())).toBeNull();
  });

  it("shows install progress and holds the message", () => {
    const installing = status({
      harness: {
        state: "installing",
        message: null,
        version: null,
        logTail: "Resolved 90 packages",
      },
    });
    expect(assistantEngineNotice(installing)).toMatchObject({
      id: "installing",
      busy: true,
      detail: "Resolved 90 packages",
    });
    expect(assistantEngineSendBlock(installing)).toContain("being installed");
  });

  it("offers Retry after a failed install", () => {
    const failed = status({
      harness: { state: "failed", message: "curl: not found", version: null, logTail: null },
    });
    expect(assistantEngineNotice(failed)).toMatchObject({
      variant: "error",
      action: "retry",
      description: "curl: not found",
    });
    expect(assistantEngineSendBlock(failed)).not.toBeNull();
  });

  it("warns when the chosen key is gone", () => {
    expect(assistantEngineNotice(status({ provider: "openai", model: "gpt-5" }))).toMatchObject({
      id: "key-missing",
      action: "settings",
    });
    expect(assistantEngineNotice(status({ provider: "xai", model: "grok-4.7" }))).toBeNull();
  });

  it("warns when the machine has no gateway key", () => {
    expect(assistantEngineNotice(status({ gatewayConfigured: false }))?.id).toBe("gateway-missing");
  });

  it("stays calm while a fresh computer's key is on its way, and lets the message go", () => {
    const pending = status({ gatewayConfigured: false, gatewayPending: true });
    expect(assistantEngineNotice(pending)).toMatchObject({
      id: "getting-ready",
      variant: "info",
      title: "Uno is getting ready…",
      busy: true,
      action: null,
    });
    expect(assistantEngineSendBlock(pending)).toBeNull();
  });

  it("leads a person who chose their own key in onboarding to add it, then to use it", () => {
    const noKeys = status({ keys: [] });
    expect(assistantEngineNotice(noKeys, { defaultAi: "byok" })).toMatchObject({
      id: "byok-add-key",
      action: "settings",
    });
    expect(assistantEngineNotice(status(), { defaultAi: "byok" })).toMatchObject({
      id: "byok-use-key",
      action: "use-key",
      provider: "xai",
    });
    expect(
      assistantEngineNotice(status(), { defaultAi: "byok", byokHintDismissed: true }),
    ).toBeNull();
    expect(assistantEngineNotice(status(), { defaultAi: "uno" })).toBeNull();
    // Already on a brought key: nothing to say.
    expect(
      assistantEngineNotice(status({ provider: "xai", model: "grok-4.7" }), { defaultAi: "byok" }),
    ).toBeNull();
  });
});
