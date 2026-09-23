import { afterEach, describe, expect, it } from "vitest";

import {
  ONBOARDING_PATH_STORAGE_KEY,
  parseOnboardingPath,
  readOnboardingPath,
  thisDeviceWords,
  writeOnboardingPath,
} from "./onboardingPath";
import { resolveOnboardingStepIds } from "./useOnboardingState";

describe("resolveOnboardingStepIds", () => {
  it("opens every flow on the path choice", () => {
    for (const flow of ["web", "desktop"] as const) {
      for (const path of ["work", "agent", "ssh"] as const) {
        expect(resolveOnboardingStepIds(flow, path)[0]).toBe("path");
      }
    }
  });

  it("keeps the existing Uno Work screens after the choice", () => {
    expect(resolveOnboardingStepIds("web", "work")).toEqual([
      "path",
      "web-computer",
      "web-away",
      "web-chat",
    ]);
    expect(resolveOnboardingStepIds("desktop", "work")).toEqual([
      "path",
      "perms",
      "what",
      "dev",
      "harness",
      "unollm",
      "rules",
    ]);
  });

  it("defaults to the Uno Work path", () => {
    expect(resolveOnboardingStepIds("web")).toEqual(resolveOnboardingStepIds("web", "work"));
    expect(resolveOnboardingStepIds("desktop")).toEqual(
      resolveOnboardingStepIds("desktop", "work"),
    );
  });

  it("gives the agent and SSH paths a single screen after the choice", () => {
    for (const flow of ["web", "desktop"] as const) {
      expect(resolveOnboardingStepIds(flow, "agent")).toEqual(["path", "agent-connect"]);
      expect(resolveOnboardingStepIds(flow, "ssh")).toEqual(["path", "ssh-access"]);
    }
  });

  it("lands on the first Uno Work screen when SSH switches back to Uno Work", () => {
    // The SSH screen's "continue with Uno Work" keeps the step index (1).
    const sshIndex = resolveOnboardingStepIds("desktop", "ssh").indexOf("ssh-access");
    expect(resolveOnboardingStepIds("desktop", "work")[sshIndex]).toBe("perms");
    expect(resolveOnboardingStepIds("web", "work")[sshIndex]).toBe("web-computer");
  });
});

describe("onboarding path storage", () => {
  afterEach(() => {
    globalThis.localStorage?.removeItem(ONBOARDING_PATH_STORAGE_KEY);
  });

  it("only accepts known paths", () => {
    expect(parseOnboardingPath("agent")).toBe("agent");
    expect(parseOnboardingPath("vps")).toBeNull();
    expect(parseOnboardingPath(null)).toBeNull();
  });

  it("round-trips through localStorage when it exists", () => {
    if (!globalThis.localStorage) {
      expect(readOnboardingPath()).toBeNull();
      return;
    }
    writeOnboardingPath("ssh");
    expect(globalThis.localStorage.getItem(ONBOARDING_PATH_STORAGE_KEY)).toBe("ssh");
    expect(readOnboardingPath()).toBe("ssh");
  });

  it("names the device in plain words", () => {
    expect(thisDeviceWords("MacIntel")).toBe("this Mac");
    expect(thisDeviceWords("Win32")).toBe("this PC");
    expect(thisDeviceWords("Linux x86_64")).toBe("this computer");
  });
});
