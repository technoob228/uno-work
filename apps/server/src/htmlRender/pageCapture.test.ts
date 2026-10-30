import { describe, expect, it } from "vitest";

import { requestAllowed } from "./pageCapture.ts";

describe("requestAllowed", () => {
  it("lets out only https to the public libraries", () => {
    expect(requestAllowed("https://cdn.jsdelivr.net/npm/chart.js")).toBe(true);
    expect(requestAllowed("https://fonts.gstatic.com/s/a.woff2")).toBe(true);
    expect(requestAllowed("http://cdn.jsdelivr.net/npm/chart.js")).toBe(false);
    expect(requestAllowed("https://evil.test/?d=1")).toBe(false);
    expect(requestAllowed("https://cdn.jsdelivr.net.evil.test/")).toBe(false);
    expect(requestAllowed("http://127.0.0.1:13773/api/keys")).toBe(false);
    expect(requestAllowed("http://169.254.169.254/latest/meta-data")).toBe(false);
    expect(requestAllowed("not a url")).toBe(false);
  });
});
