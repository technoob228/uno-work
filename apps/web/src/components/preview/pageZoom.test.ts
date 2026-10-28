import { describe, expect, it } from "vitest";

import {
  clampPageZoom,
  nextPageZoom,
  pageZoomLabel,
  PAGE_ZOOM_MAX,
  PAGE_ZOOM_MIN,
  zoomedFrameStyle,
} from "./pageZoom";

describe("page zoom steps", () => {
  it("walks Chrome's steps from 100%", () => {
    expect(nextPageZoom(1, 1)).toBe(1.1);
    expect(nextPageZoom(1.1, 1)).toBe(1.25);
    expect(nextPageZoom(1, -1)).toBe(0.9);
    expect(nextPageZoom(0.9, -1)).toBe(0.8);
  });

  it("snaps a factor between steps to the next one", () => {
    // Cmd+= inside the page moves by its own amount (~1.2).
    expect(nextPageZoom(1.2, 1)).toBe(1.25);
    expect(nextPageZoom(1.2, -1)).toBe(1.1);
    expect(nextPageZoom(1.0999, 1)).toBe(1.25);
  });

  it("stops at the ends", () => {
    expect(nextPageZoom(PAGE_ZOOM_MAX, 1)).toBe(PAGE_ZOOM_MAX);
    expect(nextPageZoom(PAGE_ZOOM_MIN, -1)).toBe(PAGE_ZOOM_MIN);
  });

  it("clamps and labels", () => {
    expect(clampPageZoom(9)).toBe(PAGE_ZOOM_MAX);
    expect(clampPageZoom(0)).toBe(1);
    expect(clampPageZoom(Number.NaN)).toBe(1);
    expect(clampPageZoom(1.234)).toBe(1.23);
    expect(pageZoomLabel(1.1)).toBe("110%");
    expect(pageZoomLabel(0.67)).toBe("67%");
  });
});

describe("the web's zoomed frame", () => {
  it("is untouched at 100% on the whole stage", () => {
    expect(zoomedFrameStyle({ zoom: 1, deviceScale: 1, size: null })).toBeUndefined();
  });

  it("lays the page out in fewer CSS pixels and scales it back", () => {
    expect(zoomedFrameStyle({ zoom: 1.25, deviceScale: 1, size: null })).toEqual({
      width: "80%",
      height: "80%",
      transform: "scale(1.25)",
      transformOrigin: "0 0",
    });
  });

  it("keeps a device's box: the zoom inside it, the fit on top", () => {
    expect(
      zoomedFrameStyle({
        zoom: 2,
        deviceScale: 0.5,
        size: { width: 390, height: 844 },
      }),
    ).toEqual({ width: 195, height: 422 });
    expect(
      zoomedFrameStyle({
        zoom: 1,
        deviceScale: 0.5,
        size: { width: 390, height: 844 },
      }),
    ).toEqual({
      width: 390,
      height: 844,
      transform: "scale(0.5)",
      transformOrigin: "0 0",
    });
  });
});
