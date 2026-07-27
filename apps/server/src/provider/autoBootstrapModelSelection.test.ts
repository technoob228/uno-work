import {
  DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderAuthStatus,
  type ServerProviderState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  FALLBACK_AUTO_BOOTSTRAP_MODEL_SELECTION,
  isUnusableAutoBootstrapDefault,
  selectAutoBootstrapModelSelection,
} from "./autoBootstrapModelSelection.ts";

const provider = (input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly models?: ReadonlyArray<string>;
  readonly authStatus?: ServerProviderAuthStatus;
  readonly status?: ServerProviderState;
  readonly enabled?: boolean;
  readonly installed?: boolean;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make(input.driver),
  enabled: input.enabled ?? true,
  installed: input.installed ?? true,
  version: "1.0.0",
  status: input.status ?? "ready",
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
});

const codexReady = provider({ instanceId: "codex", driver: "codex", models: [DEFAULT_MODEL] });
const claudeReady = provider({
  instanceId: "claudeAgent",
  driver: "claude",
  models: ["claude-sonnet-4-6", "claude-haiku-4-5"],
});

describe("selectAutoBootstrapModelSelection", () => {
  it("returns null when the machine reports no providers at all", () => {
    expect(selectAutoBootstrapModelSelection([])).toBeNull();
  });

  it("keeps codex when codex is genuinely usable", () => {
    expect(selectAutoBootstrapModelSelection([claudeReady, codexReady])).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: DEFAULT_MODEL,
    });
  });

  it("skips a driver that is installed but not logged in", () => {
    const codexLoggedOut = provider({
      instanceId: "codex",
      driver: "codex",
      models: [DEFAULT_MODEL],
      authStatus: "unauthenticated",
    });

    expect(selectAutoBootstrapModelSelection([codexLoggedOut, claudeReady])).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    });
  });

  it.each([
    ["not installed", provider({ instanceId: "codex", driver: "codex", installed: false })],
    ["disabled", provider({ instanceId: "codex", driver: "codex", enabled: false })],
    [
      "in error",
      provider({
        instanceId: "codex",
        driver: "codex",
        models: [DEFAULT_MODEL],
        status: "error",
      }),
    ],
  ])("skips a provider that is %s", (_label, unusable) => {
    expect(selectAutoBootstrapModelSelection([unusable, claudeReady])).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    });
  });

  it("uses the driver's canonical model when the instance advertises no list", () => {
    // An empty model list usually means the snapshot has not been enriched
    // yet, not that the harness is broken — auth status is the real signal.
    expect(
      selectAutoBootstrapModelSelection([provider({ instanceId: "codex", driver: "codex" })]),
    ).toEqual({ instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL });
  });

  it("skips an authenticated driver with neither models nor a canonical default", () => {
    const blank = provider({ instanceId: "custom", driver: "exotic", models: [] });

    expect(selectAutoBootstrapModelSelection([blank])).toBeNull();
  });

  it("falls back to the instance's first model when the canonical default is absent", () => {
    const claudeWithoutCanonical = provider({
      instanceId: "claudeAgent",
      driver: "claude",
      models: ["claude-opus-4-8"],
    });

    expect(selectAutoBootstrapModelSelection([claudeWithoutCanonical])).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-4-8",
    });
  });

  it("still picks an unranked driver over nothing", () => {
    const exotic = provider({ instanceId: "custom", driver: "exotic", models: ["m1"] });

    expect(selectAutoBootstrapModelSelection([exotic])).toEqual({
      instanceId: ProviderInstanceId.make("custom"),
      model: "m1",
    });
  });

  it("ignores an instance whose driver this build no longer ships", () => {
    const unavailable: ServerProvider = {
      ...provider({ instanceId: "codex", driver: "codex", models: [DEFAULT_MODEL] }),
      availability: "unavailable",
    };

    expect(selectAutoBootstrapModelSelection([unavailable, claudeReady])).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    });
  });
});

describe("isUnusableAutoBootstrapDefault", () => {
  it("flags the server's own fallback when its instance cannot run", () => {
    const codexLoggedOut = provider({
      instanceId: "codex",
      driver: "codex",
      models: [DEFAULT_MODEL],
      authStatus: "unauthenticated",
    });

    expect(
      isUnusableAutoBootstrapDefault(FALLBACK_AUTO_BOOTSTRAP_MODEL_SELECTION, [codexLoggedOut]),
    ).toBe(true);
  });

  it("leaves the fallback alone once its instance works", () => {
    expect(
      isUnusableAutoBootstrapDefault(FALLBACK_AUTO_BOOTSTRAP_MODEL_SELECTION, [codexReady]),
    ).toBe(false);
  });

  it("never touches a selection the user picked, even an unusable one", () => {
    const userPicked = { instanceId: ProviderInstanceId.make("hermes"), model: "x-ai/grok-4.20" };

    expect(isUnusableAutoBootstrapDefault(userPicked, [])).toBe(false);
  });

  it("treats a codex default on a different model as user-chosen", () => {
    expect(
      isUnusableAutoBootstrapDefault(
        { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
        [],
      ),
    ).toBe(false);
  });

  it("has nothing to repair when the project carries no default", () => {
    expect(isUnusableAutoBootstrapDefault(null, [])).toBe(false);
  });
});
