/**
 * The browser tab's device sizes (Mobile, Tablet, Desktop): a size bigger than
 * the panel renders at its real size and the picture shrinks to fit, like
 * DevTools' device mode with "Fit to window" (Misha 18.10). Clicks, scrolling
 * and Comment keep working: the page itself is not resized, only drawn smaller.
 */

/** Fit the panel, or a fixed zoom. */
export type DeviceZoom = "fit" | number;

export const DEVICE_ZOOM_CHOICES: ReadonlyArray<DeviceZoom> = ["fit", 1, 0.75, 0.5];

/** Padding of the device stage (p-4 on each side). */
const DEVICE_STAGE_PADDING = 32;

/** How much a device-sized page is drawn: Fit never grows it past 100%. */
export function deviceScaleFor(
  size: { readonly width: number; readonly height: number },
  stage: { readonly width: number; readonly height: number } | null,
  zoom: DeviceZoom,
): number {
  if (zoom !== "fit") return zoom;
  if (!stage) return 1;
  const fit = Math.min(
    (stage.width - DEVICE_STAGE_PADDING) / size.width,
    (stage.height - DEVICE_STAGE_PADDING) / size.height,
  );
  return Math.max(0.1, Math.min(1, fit));
}
