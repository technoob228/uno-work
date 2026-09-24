import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  parseProviderSetupKey,
  providerPaneBadgeLabel,
  providerSetupKey,
  resolveProviderPaneKind,
} from "./modelPickerProviderPane";

const makeProvider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-12T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const entryFor = (overrides: Partial<ServerProvider> = {}) =>
  deriveProviderInstanceEntries([makeProvider(overrides)])[0]!;

describe("resolveProviderPaneKind", () => {
  it("shows the model list for an installed, signed-in provider", () => {
    expect(resolveProviderPaneKind(entryFor())).toBe("models");
  });

  it("shows the install pane when the binary is missing and we can install it", () => {
    expect(resolveProviderPaneKind(entryFor({ installed: false, status: "error" }))).toBe(
      "install",
    );
  });

  it("blocks a missing binary we cannot install (Uno ships in the box)", () => {
    expect(
      resolveProviderPaneKind(
        entryFor({
          instanceId: ProviderInstanceId.make("uno"),
          driver: ProviderDriverKind.make("uno"),
          installed: false,
          status: "error",
        }),
      ),
    ).toBe("blocked");
  });

  it("shows the sign-in pane for an installed provider without an account", () => {
    expect(
      resolveProviderPaneKind(entryFor({ auth: { status: "unauthenticated" }, status: "error" })),
    ).toBe("signin");
    // Auth could not be verified on a provider that is not ready: for
    // Claude/Codex that reads as "not signed in".
    expect(
      resolveProviderPaneKind(entryFor({ auth: { status: "unknown" }, status: "warning" })),
    ).toBe("signin");
  });

  it("offers the sign-in pane for a signed-out harness without the in-app dialog", () => {
    for (const driver of ["cursor", "opencode", "uno"]) {
      expect(
        resolveProviderPaneKind(
          entryFor({
            instanceId: ProviderInstanceId.make(driver),
            driver: ProviderDriverKind.make(driver),
            auth: { status: "unauthenticated" },
            status: "error",
          }),
        ),
      ).toBe("signin");
    }
  });

  it("does not guess a sign-out from unknown auth on those harnesses", () => {
    expect(
      resolveProviderPaneKind(
        entryFor({
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
          auth: { status: "unknown" },
          status: "error",
        }),
      ),
    ).toBe("blocked");
  });

  it("blocks providers that are disabled in settings or unavailable", () => {
    expect(resolveProviderPaneKind(entryFor({ enabled: false, status: "disabled" }))).toBe(
      "blocked",
    );
    expect(
      resolveProviderPaneKind(
        entryFor({
          enabled: false,
          installed: false,
          status: "error",
          availability: "unavailable",
          unavailableReason: "No driver for this kind.",
        }),
      ),
    ).toBe("blocked");
  });
});

describe("providerPaneBadgeLabel", () => {
  it("maps pane kinds to plain labels", () => {
    expect(providerPaneBadgeLabel({ kind: "models" })).toBe("Ready");
    expect(providerPaneBadgeLabel({ kind: "install" })).toBe("Not installed");
    expect(providerPaneBadgeLabel({ kind: "signin" })).toBe("Sign in needed");
    expect(providerPaneBadgeLabel({ kind: "blocked" })).toBeNull();
  });

  it("reports an install in progress", () => {
    expect(
      providerPaneBadgeLabel({ kind: "install", installJob: { state: "running", log: "" } }),
    ).toBe("Installing…");
    expect(
      providerPaneBadgeLabel({ kind: "install", installJob: { state: "failed", log: "" } }),
    ).toBe("Not installed");
  });
});

describe("provider setup keys", () => {
  it("round-trips an instance id", () => {
    const key = providerSetupKey(ProviderInstanceId.make("claudeAgent"));
    expect(parseProviderSetupKey(key)).toBe("claudeAgent");
  });

  it("never matches a model key", () => {
    expect(parseProviderSetupKey("claudeAgent:claude-opus-4-6")).toBeNull();
    expect(parseProviderSetupKey("setup:claudeAgent")).toBeNull();
  });
});
