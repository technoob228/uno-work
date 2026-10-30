import { describe, expect, it } from "vitest";

import {
  assistantProfileTab,
  assistantSettingsSearch,
  memberOfLegacyView,
  settingsListOrder,
} from "./assistantSettingsNav.logic";

const member = (
  environmentId: string,
  projectId: string,
  extra: Partial<{ isUno: boolean; revoked: boolean }> = {},
) => ({
  environmentId,
  projectId,
  isUno: extra.isUno ?? false,
  revoked: extra.revoked ?? false,
});

const unoCloud = member("env-cloud", "assistant-home", { isUno: true });
const unoMac = member("env-mac", "assistant-home", { isUno: true });
const mia = member("env-cloud", "assistant-mia");
const rexGone = member("env-cloud", "assistant-rex", { revoked: true });

describe("one page for an assistant's settings", () => {
  it("opens its page by computer and folder", () => {
    expect(assistantSettingsSearch(mia)).toEqual({
      view: "profile",
      env: "env-cloud",
      project: "assistant-mia",
    });
  });

  it("opens a tab by the address; General when none or unknown", () => {
    expect(assistantSettingsSearch(mia, "memory")).toEqual({
      view: "profile",
      env: "env-cloud",
      project: "assistant-mia",
      tab: "memory",
    });
    expect(assistantSettingsSearch(mia, "general")).not.toHaveProperty("tab");
    expect(assistantProfileTab("apps")).toBe("apps");
    expect(assistantProfileTab("nope")).toBe("general");
    expect(assistantProfileTab(undefined)).toBe("general");
  });

  it("an old Uno card link opens the active computer's Uno, else any Uno", () => {
    const team = [unoCloud, unoMac, mia];
    expect(memberOfLegacyView(team, { view: "card" }, "env-mac")).toBe(unoMac);
    expect(memberOfLegacyView(team, { view: "card" }, "env-other")).toBe(unoCloud);
    expect(memberOfLegacyView([mia], { view: "card" }, "env-cloud")).toBeNull();
  });

  it("an old helper link opens that helper, removed ones too", () => {
    const team = [unoCloud, mia, rexGone];
    expect(memberOfLegacyView(team, { view: "local", project: "assistant-mia" }, "env-cloud")).toBe(
      mia,
    );
    expect(memberOfLegacyView(team, { view: "local", project: "assistant-rex" }, null)).toBe(
      rexGone,
    );
    expect(memberOfLegacyView(team, { view: "local", project: "assistant-none" }, null)).toBeNull();
  });

  it("lists Uno first, the helpers next, removed ones apart", () => {
    const { live, removed } = settingsListOrder([mia, rexGone, unoCloud]);
    expect(live).toEqual([unoCloud, mia]);
    expect(removed).toEqual([rexGone]);
  });
});
