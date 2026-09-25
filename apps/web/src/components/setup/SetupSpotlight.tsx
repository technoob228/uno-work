/**
 * A ring around one element outside the setup page (the sidebar's New
 * button on the Project step), following it while the layout settles and on
 * resize. Nothing on narrow screens, where the sidebar is a sheet.
 */
import { useLayoutEffect, useState } from "react";

interface Rect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

function read(selector: string): Rect | null {
  if (typeof window === "undefined" || window.innerWidth < 900) return null;
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

export function SetupSpotlight({ selector }: { selector: string }) {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    let until = performance.now() + 1200;
    const tick = () => {
      setRect(read(selector));
      if (performance.now() < until) frame = window.requestAnimationFrame(tick);
    };
    tick();
    const onResize = () => {
      until = performance.now() + 300;
      window.cancelAnimationFrame(frame);
      tick();
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [selector]);
  if (!rect) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-[60] rounded-lg ring-2 ring-primary ring-offset-2 ring-offset-background transition-all duration-200"
      style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
    />
  );
}
