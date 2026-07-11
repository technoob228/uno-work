import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { resolveSelectableProvider } from "./providerModels";

function provider(input: {
  provider: string;
  instanceId?: string;
  enabled?: boolean;
  installed?: boolean;
  availability?: ServerProvider["availability"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId ?? input.provider),
    driver: ProviderDriverKind.make(input.provider),
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: null,
    status: "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("resolveSelectableProvider", () => {
  it("honors the request when the harness is installed", () => {
    const providers = [provider({ provider: "codex" }), provider({ provider: "claudeAgent" })];

    expect(resolveSelectableProvider(providers, ProviderInstanceId.make("claudeAgent"))).toBe(
      "claudeAgent",
    );
  });

  it("falls back off an enabled-but-uninstalled request to an installed harness", () => {
    const providers = [
      provider({ provider: "codex", installed: false }),
      provider({ provider: "claudeAgent", installed: true }),
    ];

    // codex is enabled by default but its binary is missing — the selection
    // should transparently move to the installed Claude harness.
    expect(resolveSelectableProvider(providers, ProviderInstanceId.make("codex"))).toBe(
      "claudeAgent",
    );
  });

  it("prefers an installed harness for an unknown/absent request", () => {
    const providers = [
      provider({ provider: "codex", installed: false }),
      provider({ provider: "opencode", installed: true }),
    ];

    expect(resolveSelectableProvider(providers, null)).toBe("opencode");
    expect(resolveSelectableProvider(providers, ProviderInstanceId.make("removed_instance"))).toBe(
      "opencode",
    );
  });

  it("keeps the enabled request when nothing is installed", () => {
    const providers = [
      provider({ provider: "codex", installed: false }),
      provider({ provider: "claudeAgent", installed: false }),
    ];

    // Every harness is uninstalled: surface the requested one so the UI can
    // render a single "install this harness" hint instead of guessing.
    expect(resolveSelectableProvider(providers, ProviderInstanceId.make("codex"))).toBe("codex");
  });

  it("skips disabled harnesses even when installed", () => {
    const providers = [
      provider({ provider: "codex", enabled: false, installed: true }),
      provider({ provider: "opencode", enabled: true, installed: true }),
    ];

    expect(resolveSelectableProvider(providers, ProviderInstanceId.make("codex"))).toBe("opencode");
  });

  it("does not select an unavailable (unknown-driver) shadow", () => {
    const providers = [
      // Unavailable shadows always report enabled:false + installed:false.
      provider({
        provider: "cursor",
        enabled: false,
        installed: false,
        availability: "unavailable",
      }),
      provider({ provider: "claudeAgent", installed: true }),
    ];

    expect(resolveSelectableProvider(providers, ProviderInstanceId.make("cursor"))).toBe(
      "claudeAgent",
    );
  });

  it("falls back to the default driver when there are no providers", () => {
    expect(resolveSelectableProvider([], null)).toBe("codex");
  });
});
