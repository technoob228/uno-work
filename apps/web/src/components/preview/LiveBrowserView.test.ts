import { describe, expect, it } from "vitest";

import { browserMachineName } from "./LiveBrowserView";

describe('"Runs on …" in the browser panel', () => {
  it("is the computer's name from the sidebar", () => {
    expect(browserMachineName("uno-work", "img-208-warm")).toBe("uno-work");
  });

  it("falls back to the daemon's own name when the sidebar has none", () => {
    expect(browserMachineName(null, "uno-work")).toBe("uno-work");
  });

  it("never shows an image's service name", () => {
    expect(browserMachineName(null, "img-208-warm")).toBe("this computer");
    expect(browserMachineName("img-208-warm", "img-208-warm")).toBe("this computer");
  });
});
