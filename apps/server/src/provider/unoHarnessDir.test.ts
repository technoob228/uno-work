import * as nodePath from "node:path";

import { describe, expect, it } from "vitest";

import { resolveUnoHarnessRoot, unoHarnessPaths } from "./unoHarnessDir.ts";

describe("Uno harness folder", () => {
  it("is ~/.unowork unless told otherwise", () => {
    expect(resolveUnoHarnessRoot("/Users/misha", {})).toBe(
      nodePath.join("/Users/misha", ".unowork"),
    );
    expect(
      resolveUnoHarnessRoot("/Users/misha", {
        UNO_WORK_HARNESS_DIR: "/Users/misha/.unowork-stage",
      }),
    ).toBe("/Users/misha/.unowork-stage");
  });

  it("keeps the same layout under any root", () => {
    expect(unoHarnessPaths("/Users/misha/.unowork", "darwin")).toEqual({
      forkPath: "/Users/misha/.unowork/uno-code/bin/uno-code",
      upstreamPath: "/Users/misha/.unowork/opencode/bin/opencode",
      upstreamHome: "/Users/misha/.unowork/opencode-home",
    });
    expect(unoHarnessPaths("/x", "win32").upstreamPath).toBe(
      nodePath.join("/x", "opencode", "bin", "opencode.exe"),
    );
  });
});
