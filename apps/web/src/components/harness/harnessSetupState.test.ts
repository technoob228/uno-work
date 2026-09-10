import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  HARNESS_ROW_DRIVERS,
  HARNESS_STATUS_LABEL,
  isAuthableDriver,
  isInstallableDriver,
  isJobActive,
  progressLine,
  resolveHarnessAction,
  resolveHarnessStatus,
} from "./harnessSetupState";

const driver = (value: string) => ProviderDriverKind.make(value);

const makeProvider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: "codex" as ServerProvider["instanceId"],
  driver: driver("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-09T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("resolveHarnessStatus", () => {
  it("waits for the first provider snapshot before claiming anything is missing", () => {
    expect(resolveHarnessStatus({ provider: undefined, providersLoaded: false })).toBe("checking");
  });

  it("reports a harness the daemon does not know about as not installed", () => {
    expect(resolveHarnessStatus({ provider: undefined, providersLoaded: true })).toBe(
      "notInstalled",
    );
  });

  it("reports an uninstalled binary as not installed", () => {
    const provider = makeProvider({ installed: false, status: "error" });
    expect(resolveHarnessStatus({ provider, providersLoaded: true })).toBe("notInstalled");
  });

  it("reports an authenticated harness as ready", () => {
    expect(resolveHarnessStatus({ provider: makeProvider(), providersLoaded: true })).toBe("ready");
  });

  it("reports an explicitly unauthenticated harness as needing sign-in", () => {
    const provider = makeProvider({ auth: { status: "unauthenticated" }, status: "warning" });
    expect(resolveHarnessStatus({ provider, providersLoaded: true })).toBe("needsSignIn");
  });

  it("treats an unverifiable account on a non-ready provider as needing sign-in", () => {
    const provider = makeProvider({ auth: { status: "unknown" }, status: "warning" });
    expect(resolveHarnessStatus({ provider, providersLoaded: true })).toBe("needsSignIn");
  });

  it("keeps a ready provider ready when auth could not be verified", () => {
    const provider = makeProvider({ auth: { status: "unknown" }, status: "ready" });
    expect(resolveHarnessStatus({ provider, providersLoaded: true })).toBe("ready");
  });

  it("flags a disabled or broken provider as needing attention", () => {
    const disabled = makeProvider({
      enabled: false,
      status: "disabled",
      auth: { status: "unknown" },
    });
    expect(resolveHarnessStatus({ provider: disabled, providersLoaded: true })).toBe("attention");
    const broken = makeProvider({ status: "error" });
    expect(resolveHarnessStatus({ provider: broken, providersLoaded: true })).toBe("attention");
  });
});

describe("resolveHarnessAction", () => {
  it("offers Install only for harnesses we can install", () => {
    expect(resolveHarnessAction({ driver: driver("codex"), status: "notInstalled" })).toBe(
      "install",
    );
    expect(resolveHarnessAction({ driver: driver("hermes"), status: "notInstalled" })).toBe(
      "install",
    );
    // Uno ships in the box; there is nothing to install.
    expect(resolveHarnessAction({ driver: driver("uno"), status: "notInstalled" })).toBe("none");
  });

  it("offers Sign in only for harnesses with an in-app sign-in flow", () => {
    expect(resolveHarnessAction({ driver: driver("claudeAgent"), status: "needsSignIn" })).toBe(
      "signIn",
    );
    expect(resolveHarnessAction({ driver: driver("codex"), status: "attention" })).toBe("signIn");
    expect(resolveHarnessAction({ driver: driver("cursor"), status: "needsSignIn" })).toBe("none");
  });

  it("offers nothing while checking or when ready", () => {
    expect(resolveHarnessAction({ driver: driver("codex"), status: "checking" })).toBe("none");
    expect(resolveHarnessAction({ driver: driver("codex"), status: "ready" })).toBe("none");
  });
});

describe("driver predicates", () => {
  it("knows which drivers can be installed and signed in", () => {
    expect(isInstallableDriver(driver("cursor"))).toBe(true);
    expect(isInstallableDriver(driver("uno"))).toBe(false);
    expect(isAuthableDriver(driver("claudeAgent"))).toBe(true);
    expect(isAuthableDriver(driver("opencode"))).toBe(false);
  });
});

describe("isJobActive", () => {
  it("treats queued and running as active, terminal states as not", () => {
    expect(isJobActive({ state: "queued", log: "" })).toBe(true);
    expect(isJobActive({ state: "running", log: "" })).toBe(true);
    expect(isJobActive({ state: "succeeded", log: "" })).toBe(false);
    expect(isJobActive({ state: "failed", log: "" })).toBe(false);
    expect(isJobActive(undefined)).toBe(false);
  });
});

describe("progressLine", () => {
  it("returns the last meaningful line without colour codes", () => {
    expect(progressLine("npm WARN x\n\u001b[32madded 3 packages\u001b[0m\n\n")).toBe(
      "added 3 packages",
    );
  });

  it("returns undefined for an empty log", () => {
    expect(progressLine("\n  \n")).toBeUndefined();
  });
});

describe("row list", () => {
  it("lists every supported harness once", () => {
    expect([...HARNESS_ROW_DRIVERS].map(String)).toEqual([
      "uno",
      "claudeAgent",
      "codex",
      "opencode",
      "hermes",
      "cursor",
    ]);
  });

  it("has a label for every status", () => {
    for (const status of [
      "checking",
      "ready",
      "needsSignIn",
      "notInstalled",
      "attention",
    ] as const) {
      expect(HARNESS_STATUS_LABEL[status].length).toBeGreaterThan(0);
    }
  });
});
