import { describe, expect, it } from "vitest";

import type { ProgramTile } from "../computer/programModel";
import { acceptAppConnect, isNotetakerAddress, parseAppConnectMessage } from "./appConnectBridge";

const frame = { name: "notetaker frame" };
const other = { name: "another frame" };

describe("Connect from an app's frame", () => {
  it("takes only the calendar providers", () => {
    expect(parseAppConnectMessage({ type: "uno-work:connect", provider: "gmail" })).toBe("gmail");
    expect(parseAppConnectMessage({ type: "uno-work:connect", provider: "microsoft" })).toBe(
      "microsoft",
    );
    expect(parseAppConnectMessage({ type: "uno-work:connect", provider: "github" })).toBeNull();
    expect(parseAppConnectMessage({ type: "uno-work:connect", provider: "GMAIL" })).toBeNull();
    expect(parseAppConnectMessage({ type: "uno-work:open", provider: "gmail" })).toBeNull();
    expect(parseAppConnectMessage("uno-work:connect")).toBeNull();
    expect(parseAppConnectMessage(null)).toBeNull();
  });

  it("only from the Notetaker's own frame", () => {
    const data = { type: "uno-work:connect", provider: "microsoft" };
    expect(acceptAppConnect({ source: frame, frameWindow: frame, data })).toBe("microsoft");
    expect(acceptAppConnect({ source: other, frameWindow: frame, data })).toBeNull();
    // The frame isn't there (yet / any more): nothing is its window.
    expect(acceptAppConnect({ source: null, frameWindow: null, data })).toBeNull();
    expect(acceptAppConnect({ source: undefined, frameWindow: undefined, data })).toBeNull();
  });

  it("knows the Notetaker's address among the computer's apps", () => {
    const tile = (templateId: string, openUrl: string): ProgramTile => ({
      key: `store:${templateId}`,
      name: templateId,
      icon: null,
      iconImage: null,
      templateId,
      status: "running",
      caption: "",
      openUrl,
      online: false,
      machineApp: null,
      storeApp: {
        key: "service:1",
        name: templateId,
        templateId,
        icon: null,
        state: "running",
        url: openUrl,
        deploymentId: 1,
      },
      install: null,
    });
    const tiles = [
      tile("nextcloud", "https://files.example.com/"),
      tile("notetaker", "https://notes.example.com/"),
    ];
    expect(isNotetakerAddress("https://notes.example.com/#/settings", tiles)).toBe(true);
    expect(isNotetakerAddress("https://files.example.com/", tiles)).toBe(false);
    expect(isNotetakerAddress("not a url", tiles)).toBe(false);
  });
});
