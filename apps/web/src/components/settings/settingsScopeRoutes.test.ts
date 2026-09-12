import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  SETTINGS_SCOPE_SWITCH_HINT,
  appSettingsPath,
  correspondingSectionForScope,
  environmentSettingsPath,
  parseSettingsScopeLocation,
  resolveSettingsScopeSwitch,
  sectionExistsInScope,
  settingsLandingPath,
} from "./settingsScopeRoutes.ts";

const HOSTKEY = "env-hostkey" as EnvironmentId;
const LOCAL = "env-local" as EnvironmentId;
const KNOWN = [LOCAL, HOSTKEY];

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

describe("sectionExistsInScope", () => {
  it("knows which scope owns a section", () => {
    expect(sectionExistsInScope("general", "app")).toBe(true);
    expect(sectionExistsInScope("general", "environment")).toBe(true);
    expect(sectionExistsInScope("browser", "environment")).toBe(false);
    expect(sectionExistsInScope("providers", "app")).toBe(false);
    expect(sectionExistsInScope(null, "app")).toBe(false);
  });
});

describe("resolveSettingsScopeSwitch", () => {
  it("keeps a section that has a counterpart on the chosen machine", () => {
    expect(
      resolveSettingsScopeSwitch({
        section: "general",
        target: { kind: "environment", environmentId: HOSTKEY },
        knownEnvironmentIds: KNOWN,
      }),
    ).toEqual({
      to: "/settings/environment/env-hostkey/general",
      keptSection: true,
      unknownMachine: false,
    });
  });

  it("lands on the machine's first section when the section has no counterpart", () => {
    // "browser" belongs to the app; a machine has no such page.
    const result = resolveSettingsScopeSwitch({
      section: "browser",
      target: { kind: "environment", environmentId: HOSTKEY },
      knownEnvironmentIds: KNOWN,
    });

    expect(result.to).toBe("/settings/environment/env-hostkey/general");
    expect(result.keptSection).toBe(false);
    expect(result.unknownMachine).toBe(false);
  });

  it("flags a machine the app does not know instead of picking another one", () => {
    const result = resolveSettingsScopeSwitch({
      section: "providers",
      target: { kind: "environment", environmentId: "env-gone" as EnvironmentId },
      knownEnvironmentIds: KNOWN,
    });

    expect(result.to).toBe("/settings/environment/env-gone/providers");
    expect(result.unknownMachine).toBe(true);
  });

  it("switches to the app scope, falling back for machine-only sections", () => {
    expect(
      resolveSettingsScopeSwitch({
        section: "connections",
        target: { kind: "app" },
        knownEnvironmentIds: KNOWN,
      }),
    ).toEqual({ to: "/settings/app/connections", keptSection: true, unknownMachine: false });

    expect(
      resolveSettingsScopeSwitch({
        section: "providers",
        target: { kind: "app" },
        knownEnvironmentIds: KNOWN,
      }),
    ).toEqual({ to: "/settings/app/general", keptSection: false, unknownMachine: false });
  });

  it("treats a flat page (no section on either scope) as a fallback", () => {
    const result = resolveSettingsScopeSwitch({
      section: "vault",
      target: { kind: "environment", environmentId: LOCAL },
      knownEnvironmentIds: KNOWN,
    });

    expect(result.to).toBe("/settings/environment/env-local/general");
    expect(result.keptSection).toBe(false);
  });

  it("explains the split in plain words", () => {
    expect(SETTINGS_SCOPE_SWITCH_HINT).toContain("General and Theme apply to this app");
    expect(SETTINGS_SCOPE_SWITCH_HINT).toContain("live on each machine");
  });
});

describe("settingsLandingPath", () => {
  it("returns to the machine the user was configuring last", () => {
    expect(
      settingsLandingPath({
        memory: { machineEnvironmentId: HOSTKEY, lastKind: "environment" },
        knownEnvironmentIds: KNOWN,
      }),
    ).toBe("/settings/environment/env-hostkey/general");
  });

  it("lands on the app scope when the last page was app-scoped, even with a remembered machine", () => {
    expect(
      settingsLandingPath({
        memory: { machineEnvironmentId: HOSTKEY, lastKind: "app" },
        knownEnvironmentIds: KNOWN,
      }),
    ).toBe("/settings/app/general");
  });

  it("does not land on a machine the app no longer knows", () => {
    expect(
      settingsLandingPath({
        memory: { machineEnvironmentId: "env-gone", lastKind: "environment" },
        knownEnvironmentIds: KNOWN,
      }),
    ).toBe("/settings/app/general");
  });

  it("lands on the app scope when nothing is remembered", () => {
    expect(
      settingsLandingPath({
        memory: { machineEnvironmentId: null, lastKind: "app" },
        knownEnvironmentIds: [],
      }),
    ).toBe("/settings/app/general");
  });
});
