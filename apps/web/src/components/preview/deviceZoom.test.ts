import { describe, expect, it } from "vitest";

import { deviceScaleFor } from "./deviceZoom";

const desktop = { width: 1280, height: 800 };

describe("deviceScaleFor", () => {
  it("Fit shrinks a size wider than the panel to its width", () => {
    // 832 + 32 padding wide, tall enough: 832 / 1280 = 65%.
    expect(deviceScaleFor(desktop, { width: 864, height: 2000 }, "fit")).toBeCloseTo(0.65);
  });

  it("Fit takes the tighter side, like DevTools", () => {
    expect(deviceScaleFor(desktop, { width: 2000, height: 432 }, "fit")).toBeCloseTo(0.5);
  });

  it("Fit never grows a size that fits", () => {
    expect(deviceScaleFor({ width: 390, height: 844 }, { width: 1200, height: 1200 }, "fit")).toBe(
      1,
    );
  });

  it("a fixed zoom is what was picked", () => {
    expect(deviceScaleFor(desktop, { width: 300, height: 300 }, 0.75)).toBe(0.75);
  });

  it("before the panel is measured: 100%", () => {
    expect(deviceScaleFor(desktop, null, "fit")).toBe(1);
  });
});
