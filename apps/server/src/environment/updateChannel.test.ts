import { describe, expect, it } from "vitest";

import { resolveUpdateChannel } from "./updateChannel.ts";

describe("resolveUpdateChannel", () => {
  it("is the release without any setting", () => {
    expect(resolveUpdateChannel({})).toBeUndefined();
    expect(
      resolveUpdateChannel({ UNO_WORK_UPDATE_BASE_URL: "https://console.uno.place/cli/work" }),
    ).toBeUndefined();
    expect(
      resolveUpdateChannel({ UNO_WORK_UPDATE_BASE_URL: "https://console.uno.place/cli/work/" }),
    ).toBeUndefined();
  });

  it("reads the channel from the update address", () => {
    expect(
      resolveUpdateChannel({
        UNO_WORK_UPDATE_BASE_URL: "https://console.uno.place/cli/work/stage",
      }),
    ).toBe("stage");
    expect(
      resolveUpdateChannel({
        UNO_WORK_UPDATE_BASE_URL: "https://console.uno.place/cli/work/canary/",
      }),
    ).toBe("canary");
  });

  it("ignores other addresses and odd names", () => {
    expect(
      resolveUpdateChannel({ UNO_WORK_UPDATE_BASE_URL: "https://example.com/stage" }),
    ).toBeUndefined();
    expect(
      resolveUpdateChannel({
        UNO_WORK_UPDATE_BASE_URL: "https://console.uno.place/cli/work/stage/extra",
      }),
    ).toBeUndefined();
    expect(resolveUpdateChannel({ UNO_WORK_UPDATE_BASE_URL: "not a url" })).toBeUndefined();
    expect(resolveUpdateChannel({ UNO_WORK_CHANNEL: "Stage!" })).toBeUndefined();
  });

  it("prefers UNO_WORK_CHANNEL", () => {
    expect(
      resolveUpdateChannel({
        UNO_WORK_CHANNEL: "stage",
        UNO_WORK_UPDATE_BASE_URL: "https://console.uno.place/cli/work",
      }),
    ).toBe("stage");
  });
});
