import path from "node:path";

import { describe, expect, it } from "vitest";

import { assistantsDirOverride, resolveAssistantsDir } from "./assistantsDir.ts";

describe("resolveAssistantsDir", () => {
  it("is ~/UnoWork/Assistants by default", () => {
    expect(resolveAssistantsDir("/Users/misha", {})).toBe(
      path.join("/Users/misha", "UnoWork", "Assistants"),
    );
    expect(resolveAssistantsDir("/Users/misha", { UNO_WORK_ASSISTANTS_DIR: "  " })).toBe(
      path.join("/Users/misha", "UnoWork", "Assistants"),
    );
  });

  it("follows UNO_WORK_ASSISTANTS_DIR (Uno Work Stage)", () => {
    expect(
      resolveAssistantsDir("/Users/misha", {
        UNO_WORK_ASSISTANTS_DIR: "/Users/misha/.unowork-stage/Assistants",
      }),
    ).toBe("/Users/misha/.unowork-stage/Assistants");
    expect(assistantsDirOverride({})).toBeNull();
  });
});
