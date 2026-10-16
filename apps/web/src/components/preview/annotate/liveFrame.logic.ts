/**
 * Where the live picture of a computer's page sits in its box (object-fit:
 * contain; at the top with Labs `panelLauncherV2`, centred without), and the
 * way between the person's pointer and the page's CSS pixels — for input, for
 * Comment's pointer, and for putting the note box next to the picked element.
 */

export interface FrameFit {
  /** Picture pixels per page CSS pixel. */
  readonly scale: number;
  /** Where the picture starts inside the box. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** The picture's size in the box. */
  readonly width: number;
  readonly height: number;
}

export function fitFrame(
  box: { readonly width: number; readonly height: number },
  frame: { readonly width: number; readonly height: number },
  pinTop: boolean,
): FrameFit | null {
  if (frame.width <= 0 || frame.height <= 0 || box.width <= 0 || box.height <= 0) return null;
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const width = frame.width * scale;
  const height = frame.height * scale;
  return {
    scale,
    offsetX: (box.width - width) / 2,
    offsetY: pinTop ? 0 : (box.height - height) / 2,
    width,
    height,
  };
}

/** A point in the box (relative to its top-left) → the page's CSS pixels; null — off the picture. */
export function boxPointToPage(
  point: { readonly x: number; readonly y: number },
  fit: FrameFit,
  frame: { readonly width: number; readonly height: number },
): { x: number; y: number } | null {
  const x = (point.x - fit.offsetX) / fit.scale;
  const y = (point.y - fit.offsetY) / fit.scale;
  if (x < 0 || y < 0 || x > frame.width || y > frame.height) return null;
  return { x: Math.round(x), y: Math.round(y) };
}
