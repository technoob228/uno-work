import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  getDefaultServerModel,
  isUsableDefaultProvider,
  resolveDefaultThreadProvider,
  resolveSelectableProvider,
} from "./providerModels";

function provider(input: {
  provider: string;
  instanceId?: string;
  enabled?: boolean;
  installed?: boolean;
  availability?: ServerProvider["availability"];
  authStatus?: ServerProvider["auth"]["status"];
  status?: ServerProvider["status"];
  models?: ReadonlyArray<string>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId ?? input.provider),
    driver: ProviderDriverKind.make(input.provider),
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: null,
    status: input.status ?? "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: input.authStatus ?? "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: (input.models ?? []).map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
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

const UNO_DEFAULT = "uno/moonshotai/kimi-k2.7-code";

const unoConnected = provider({
  provider: "uno",
  models: ["uno/anthropic/claude-opus-4.7", UNO_DEFAULT],
});
// Fresh Work box: no gateway key yet, so the snapshot has neither models nor
// an authenticated status.
const unoNotLinked = provider({ provider: "uno", authStatus: "unknown", status: "warning" });
const codexLoggedIn = provider({ provider: "codex", models: ["gpt-5.4"] });
const codexLoggedOut = provider({
  provider: "codex",
  authStatus: "unauthenticated",
  status: "warning",
  models: ["gpt-5.4"],
});
const opencodeZen = provider({ provider: "opencode", models: ["opencode/zen-free"] });

describe("isUsableDefaultProvider", () => {
  it("accepts a connected harness with models", () => {
    expect(isUsableDefaultProvider(unoConnected)).toBe(true);
  });

  it.each([
    ["not signed in", codexLoggedOut],
    ["not linked (no key, no models)", unoNotLinked],
    ["not installed", provider({ provider: "codex", installed: false, models: ["gpt-5.4"] })],
    ["disabled", provider({ provider: "codex", enabled: false, models: ["gpt-5.4"] })],
    ["erroring", provider({ provider: "codex", status: "error", models: ["gpt-5.4"] })],
    ["authenticated but without models", provider({ provider: "uno" })],
  ])("rejects a harness that is %s", (_label, candidate) => {
    expect(isUsableDefaultProvider(candidate)).toBe(false);
  });
});

describe("resolveDefaultThreadProvider", () => {
  // The fresh-Work-box matrix: uno linked/unlinked × codex signed in/out.
  it("uno linked + codex signed out → built-in Uno wins over the codex seed", () => {
    const providers = [unoConnected, codexLoggedOut, opencodeZen];

    expect(resolveDefaultThreadProvider(providers, ProviderInstanceId.make("codex"))).toBe("uno");
    expect(resolveDefaultThreadProvider(providers, null)).toBe("uno");
  });

  it("uno linked + codex signed in → an explicitly seeded codex default is honored", () => {
    const providers = [unoConnected, codexLoggedIn, opencodeZen];

    expect(resolveDefaultThreadProvider(providers, ProviderInstanceId.make("codex"))).toBe("codex");
  });

  it("uno linked + codex signed in, no seed → uno leads the preference order", () => {
    expect(resolveDefaultThreadProvider([codexLoggedIn, unoConnected], null)).toBe("uno");
  });

  it("uno not linked + codex signed out → free OpenCode Zen, never a dead harness", () => {
    const providers = [unoNotLinked, codexLoggedOut, opencodeZen];

    expect(resolveDefaultThreadProvider(providers, ProviderInstanceId.make("codex"))).toBe(
      "opencode",
    );
  });

  it("uno not linked + codex signed in → codex keeps its historical default", () => {
    const providers = [unoNotLinked, codexLoggedIn, opencodeZen];

    expect(resolveDefaultThreadProvider(providers, ProviderInstanceId.make("codex"))).toBe("codex");
    expect(resolveDefaultThreadProvider(providers, null)).toBe("codex");
  });

  it("nothing usable → degrades to the legacy installed-first behavior", () => {
    const providers = [unoNotLinked, codexLoggedOut];

    expect(resolveDefaultThreadProvider(providers, ProviderInstanceId.make("codex"))).toBe("codex");
    expect(resolveDefaultThreadProvider([], null)).toBe("codex");
  });
});

describe("getDefaultServerModel", () => {
  it("prefers the driver's canonical default over the first pinned model", () => {
    // The Uno snapshot pins headline models first (e.g. Opus) even when the
    // gateway cannot serve them; the canonical default is the one that
    // answers out of the box.
    expect(getDefaultServerModel([unoConnected], ProviderDriverKind.make("uno"))).toBe(UNO_DEFAULT);
  });

  it("falls back to the first advertised model when the canonical default is absent", () => {
    const uno = provider({ provider: "uno", models: ["uno/deepseek/deepseek-v4-pro"] });

    expect(getDefaultServerModel([uno], ProviderDriverKind.make("uno"))).toBe(
      "uno/deepseek/deepseek-v4-pro",
    );
  });

  it("keeps returning the canonical default when the snapshot has no models yet", () => {
    expect(getDefaultServerModel([unoNotLinked], ProviderDriverKind.make("uno"))).toBe(UNO_DEFAULT);
  });
});
