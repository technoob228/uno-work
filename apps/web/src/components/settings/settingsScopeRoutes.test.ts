import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  appSettingsPath,
  correspondingSectionForScope,
  environmentSettingsPath,
  parseSettingsScopeLocation,
} from "./settingsScopeRoutes.ts";

const HOSTKEY = "env-hostkey" as EnvironmentId;

describe("parseSettingsScopeLocation", () => {
  it("reads the environment out of the path rather than from app state", () => {
    expect(parseSettingsScopeLocation("/settings/environment/env-hostkey/providers")).toEqual({
      kind: "environment",
      environmentId: HOSTKEY,
      section: "providers",
    });
  });

  it("round-trips an environment id that needs escaping", () => {
    const id = "ssh://user@host:22" as EnvironmentId;
    const parsed = parseSettingsScopeLocation(environmentSettingsPath(id, "assistants"));

    expect(parsed.environmentId).toBe(id);
    expect(parsed.section).toBe("assistants");
  });

  it("reads app scope sections", () => {
    expect(parseSettingsScopeLocation(appSettingsPath("connections"))).toEqual({
      kind: "app",
      environmentId: null,
      section: "connections",
    });
  });

  it("treats anything unrecognised as the app scope, which owns no daemon", () => {
    expect(parseSettingsScopeLocation("/chat/thread-1").kind).toBe("app");
    expect(parseSettingsScopeLocation("/settings").kind).toBe("app");
  });
});

describe("correspondingSectionForScope", () => {
  it("keeps the section when both scopes have it", () => {
    expect(correspondingSectionForScope("general", "environment")).toBe("general");
  });

  it("falls back to the landing section instead of inventing one", () => {
    // "browser" is app-only; an environment has no such page.
    expect(correspondingSectionForScope("browser", "environment")).toBe("general");
    // "providers" is environment-only.
    expect(correspondingSectionForScope("providers", "app")).toBe("general");
  });
});
