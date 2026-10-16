import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { isProviderUnchecked, resolveUnoHandoffSelection } from "./unoDefaultSelection.logic";

function provider(input: {
  driver: string;
  version?: string | null;
  status?: ServerProvider["status"];
  authStatus?: ServerProvider["auth"]["status"];
  enabled?: boolean;
  models?: ReadonlyArray<string>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.driver),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: true,
    version: input.version === undefined ? "1.0.0" : input.version,
    status: input.status ?? "ready",
    auth: { status: input.authStatus ?? "authenticated" },
    checkedAt: "2026-10-16T00:00:00.000Z",
    models: (input.models ?? ["m"]).map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  };
}

/** The server's first snapshot, before the harness was checked. */
function unchecked(driver: string): ServerProvider {
  return provider({ driver, version: null, status: "warning", authStatus: "unknown" });
}

describe("resolveUnoHandoffSelection", () => {
  it("waits while nothing has been listed", () => {
    expect(resolveUnoHandoffSelection([])).toEqual({ settled: false, selection: null });
  });

  it("waits for Hermes to be checked on a fresh trial computer instead of starting on Claude", () => {
    // 16.10: the first list on a trial — Hermes unchecked, Claude installed but not signed in.
    const providers = [
      unchecked("hermes"),
      unchecked("uno"),
      provider({ driver: "claudeAgent", authStatus: "unauthenticated" }),
    ];
    expect(resolveUnoHandoffSelection(providers)).toEqual({ settled: false, selection: null });
  });

  it("starts on Hermes once it is checked", () => {
    const providers = [
      provider({ driver: "hermes", models: ["uno-smart"] }),
      unchecked("uno"),
      provider({ driver: "claudeAgent", authStatus: "unauthenticated" }),
    ];
    expect(resolveUnoHandoffSelection(providers)).toEqual({
      settled: true,
      selection: { instanceId: "hermes", model: "uno-smart" },
    });
  });

  it("starts on Uno Code where Hermes can't answer", () => {
    const providers = [
      provider({ driver: "hermes", status: "error", authStatus: "unknown" }),
      provider({ driver: "uno", models: ["uno-code"] }),
    ];
    expect(resolveUnoHandoffSelection(providers).selection).toEqual({
      instanceId: "uno",
      model: "uno-code",
    });
  });

  it("waits for the Uno key on a computer whose Hermes was checked before it landed", () => {
    const providers = [
      provider({ driver: "hermes", authStatus: "unauthenticated", models: ["uno-smart"] }),
      provider({ driver: "claudeAgent", authStatus: "unauthenticated" }),
    ];
    expect(resolveUnoHandoffSelection(providers).settled).toBe(false);
    // Nothing signed in after the cap: still Hermes, not the logged-out Claude.
    expect(resolveUnoHandoffSelection(providers, true)).toEqual({
      settled: true,
      selection: { instanceId: "hermes", model: "uno-smart" },
    });
  });

  it("never picks a harness that isn't signed in", () => {
    const providers = [
      provider({ driver: "hermes", status: "error", authStatus: "unauthenticated" }),
      provider({ driver: "uno", status: "error", authStatus: "unknown" }),
      provider({ driver: "claudeAgent", authStatus: "unauthenticated" }),
      provider({ driver: "opencode", models: ["zen-free"] }),
    ];
    expect(resolveUnoHandoffSelection(providers)).toEqual({
      settled: true,
      selection: { instanceId: "opencode", model: "zen-free" },
    });
  });

  it("goes on after the cap even if Uno's engine is never checked", () => {
    const providers = [unchecked("hermes"), provider({ driver: "codex", models: ["gpt"] })];
    expect(resolveUnoHandoffSelection(providers).settled).toBe(false);
    expect(resolveUnoHandoffSelection(providers, true)).toEqual({
      settled: true,
      selection: { instanceId: "codex", model: "gpt" },
    });
  });
});

describe("isProviderUnchecked", () => {
  it("is the first snapshot only", () => {
    expect(isProviderUnchecked(unchecked("hermes"))).toBe(true);
    expect(isProviderUnchecked(provider({ driver: "hermes" }))).toBe(false);
    expect(
      isProviderUnchecked(
        provider({ driver: "hermes", status: "error", authStatus: "unknown", version: null }),
      ),
    ).toBe(false);
    expect(isProviderUnchecked({ ...unchecked("hermes"), enabled: false })).toBe(false);
  });
});
