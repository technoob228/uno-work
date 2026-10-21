import { describe, expect, it } from "vitest";

import { slackRoutingCopy } from "./slackRouting";

const cloud = { name: "Work", kind: "cloud" as const, isThis: false, isDefault: true };
const mac = { name: "Mac", kind: "desktop" as const, isThis: true, isDefault: false };

describe("slackRoutingCopy", () => {
  it("says nothing with one computer and an older console", () => {
    expect(slackRoutingCopy(undefined)).toEqual({
      directLine: null,
      action: null,
      sharedLine: null,
    });
    expect(
      slackRoutingCopy({
        computers: [{ ...mac, isDefault: true }],
        isDefault: true,
        defaultChosen: false,
        shared: false,
        signedAs: null,
      }),
    ).toEqual({ directLine: null, action: null, sharedLine: null });
  });

  it("offers to answer here when another computer gets the DMs", () => {
    const copy = slackRoutingCopy({
      computers: [cloud, mac],
      isDefault: false,
      defaultChosen: false,
      shared: false,
      signedAs: null,
    });
    expect(copy.directLine).toContain("go to Work.");
    expect(copy.action).toEqual({ kind: "here", label: "Answer them here" });
  });

  it("offers to undo a picked default, not the cloud-first rule", () => {
    const base = {
      computers: [cloud, { ...mac, isDefault: true }],
      isDefault: true,
      shared: false,
      signedAs: null,
    };
    expect(slackRoutingCopy({ ...base, defaultChosen: true }).action?.kind).toBe("undo");
    expect(slackRoutingCopy({ ...base, defaultChosen: false }).action).toBeNull();
  });

  it("explains a workspace shared with other accounts", () => {
    const copy = slackRoutingCopy({
      computers: [{ ...mac, isDefault: true }],
      isDefault: true,
      defaultChosen: false,
      shared: true,
      signedAs: "Misha's assistant",
    });
    expect(copy.sharedLine).toContain("signed “Misha's assistant”");
    expect(copy.directLine).toBeNull();
  });
});
