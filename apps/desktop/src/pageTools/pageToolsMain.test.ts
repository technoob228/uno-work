import { describe, expect, it } from "vitest";

import { browserUserAgent, isPageToolsPartition } from "./pageToolsMain.ts";

describe("isPageToolsPartition", () => {
  it("is the panel browser's partitions only", () => {
    expect(isPageToolsPartition("persist:uno-browser")).toBe(true);
    expect(isPageToolsPartition("persist:uno-browser-p-my_project")).toBe(true);
    expect(isPageToolsPartition("persist:uno-apps")).toBe(false);
    expect(isPageToolsPartition("persist:uno-browserish")).toBe(false);
    expect(isPageToolsPartition(undefined)).toBe(false);
  });
});

describe("browserUserAgent", () => {
  it("drops the Electron and app tokens, keeps the real Chrome version", () => {
    expect(
      browserUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Uno Work/0.0.194 Chrome/146.0.7680.80 Electron/41.10.7 Safari/537.36",
      ),
    ).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.80 Safari/537.36",
    );
  });

  it("leaves a plain Chrome user agent as is", () => {
    const chrome =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.7680.80 Safari/537.36";
    expect(browserUserAgent(chrome)).toBe(chrome);
  });
});
