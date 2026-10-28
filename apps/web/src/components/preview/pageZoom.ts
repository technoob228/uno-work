/**
 * The page zoom of a browser tab (Misha 28.10): the steps of Chrome's
 * − 100% + (no 0.1 drift to 109.99%), and how a frame of another site is
 * zoomed in the web — scaled whole, its viewport smaller, like a browser's
 * own zoom (CSS zoom can't reach another origin's page).
 */
import type { CSSProperties } from "react";

export const PAGE_ZOOM_STEPS: ReadonlyArray<number> = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
];

export const PAGE_ZOOM_MIN = PAGE_ZOOM_STEPS[0]!;
export const PAGE_ZOOM_MAX = PAGE_ZOOM_STEPS[PAGE_ZOOM_STEPS.length - 1]!;

/** The next step up or down from any factor (one that came from Cmd+= in the page too). */
export function nextPageZoom(current: number, direction: 1 | -1): number {
  const epsilon = 0.005;
  if (direction > 0) {
    return PAGE_ZOOM_STEPS.find((step) => step > current + epsilon) ?? PAGE_ZOOM_MAX;
  }
  for (let index = PAGE_ZOOM_STEPS.length - 1; index >= 0; index -= 1) {
    const step = PAGE_ZOOM_STEPS[index]!;
    if (step < current - epsilon) return step;
  }
  return PAGE_ZOOM_MIN;
}

export function clampPageZoom(factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return Math.min(PAGE_ZOOM_MAX, Math.max(PAGE_ZOOM_MIN, Math.round(factor * 100) / 100));
}

export function pageZoomLabel(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}

export function isDefaultPageZoom(factor: number): boolean {
  return Math.abs(factor - 1) < 0.005;
}

/**
 * The web's page frame at a zoom: its box is the stage over the zoom, drawn
 * scaled back to the stage — the page lays out in fewer (or more) CSS pixels.
 * `size` is a device size (its own box), absent — the whole stage.
 */
export function zoomedFrameStyle(input: {
  readonly zoom: number;
  readonly deviceScale: number;
  readonly size: { readonly width: number; readonly height: number } | null;
}): CSSProperties | undefined {
  const { zoom, deviceScale, size } = input;
  const scale = zoom * deviceScale;
  if (!size) {
    if (isDefaultPageZoom(zoom)) return undefined;
    return {
      width: `${100 / zoom}%`,
      height: `${100 / zoom}%`,
      transform: `scale(${zoom})`,
      transformOrigin: "0 0",
    };
  }
  return {
    width: size.width / zoom,
    height: size.height / zoom,
    ...(Math.abs(scale - 1) < 0.0001
      ? {}
      : { transform: `scale(${scale})`, transformOrigin: "0 0" }),
  };
}
