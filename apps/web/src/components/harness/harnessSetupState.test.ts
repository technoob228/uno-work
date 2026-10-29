import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  describeSignInFailure,
  HARNESS_ROW_DRIVERS,
  HARNESS_STATUS_LABEL,
  isAuthableDriver,
  isInstallableDriver,
  isJobActive,
  progressLine,
  resolveHarnessAction,
  resolveHarnessStatus,
  LOST_SIGN_IN_MESSAGE,
  runsOnUnoAi,
  SIGN_IN_CODE_REJECTED_MESSAGE,
  SIGN_IN_FAILED_MESSAGE,
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

describe("Claude on Uno AI", () => {
  it("is ready without a Claude sign-in and still offers one", () => {
    const provider = makeProvider({
      driver: driver("claudeAgent"),
      auth: { status: "authenticated", type: "unoAi", label: "Uno AI" },
    });
    expect(runsOnUnoAi(provider)).toBe(true);
    expect(resolveHarnessStatus({ provider, providersLoaded: true })).toBe("ready");
    expect(resolveHarnessAction({ driver: driver("claudeAgent"), status: "ready" })).toBe("none");
    expect(runsOnUnoAi(makeProvider({ auth: { status: "authenticated", type: "maxplan" } }))).toBe(
      false,
    );
    expect(runsOnUnoAi(undefined)).toBe(false);
  });
});

describe("describeSignInFailure", () => {
  // What the daemon reported for a wrong Claude code (walk 29.10).
  const WRONG_CODE =
    "Sign-in exited with code 1. Login failed: Request failed with status code 400";

  it("turns a wrong one-time code into a human message with a new link as the way on", () => {
    const view = describeSignInFailure({
      driver: "claudeAgent",
      method: "oauth",
      codeCheck: "checking",
      error: WRONG_CODE,
      log: "$ claude auth login\nLogin failed: Request failed with status code 400\n",
    });
    expect(view.message).toBe(SIGN_IN_CODE_REJECTED_MESSAGE);
    expect(view.message).not.toMatch(/exited|status code/);
    expect(view.codeRejected).toBe(true);
    // The raw text stays one click away.
    expect(view.details).toContain(WRONG_CODE);
    expect(view.details).toContain("$ claude auth login");
  });

  it("knows Claude's 400 without codeCheck (an older daemon)", () => {
    const view = describeSignInFailure({
      driver: "claudeAgent",
      method: "oauth",
      error: WRONG_CODE,
    });
    expect(view.codeRejected).toBe(true);
    expect(view.details).toBe(WRONG_CODE);
  });

  it("anything else: a generic line, the reason under Details", () => {
    const codex = describeSignInFailure({
      driver: "codex",
      method: "oauth",
      error: "Sign-in exited with code 1. Error: getaddrinfo ENOTFOUND auth.openai.com",
    });
    expect(codex).toMatchObject({ message: SIGN_IN_FAILED_MESSAGE, codeRejected: false });
    expect(codex.details).toContain("ENOTFOUND");

    const apiKey = describeSignInFailure({
      driver: "codex",
      method: "apiKey",
      error: "Sign-in exited with code 1. status code 400",
    });
    expect(apiKey).toMatchObject({ message: SIGN_IN_FAILED_MESSAGE, codeRejected: false });

    expect(describeSignInFailure({ driver: "claudeAgent", method: "oauth" })).toMatchObject({
      message: SIGN_IN_FAILED_MESSAGE,
      codeRejected: false,
      details: "",
    });
  });

  it("keeps our own sentences as they are", () => {
    const view = describeSignInFailure({
      driver: "claudeAgent",
      method: "oauth",
      codeCheck: "checking",
      error: LOST_SIGN_IN_MESSAGE,
    });
    expect(view).toEqual({ message: LOST_SIGN_IN_MESSAGE, codeRejected: false, details: "" });
  });
});
