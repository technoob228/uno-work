import { useLayoutEffect, useRef, type ReactNode } from "react";

import { ScrollArea } from "../ui/scroll-area";
import { getScrollPosition, setScrollPosition } from "./previewScrollMemory";

export function attachScrollMemory(el: HTMLElement, fileId: string): () => void {
  const saved = getScrollPosition(fileId);
  if (saved !== undefined) {
    el.scrollTop = saved;
  }
  let frame = 0;
  const onScroll = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      setScrollPosition(fileId, el.scrollTop);
    });
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    cancelAnimationFrame(frame);
    el.removeEventListener("scroll", onScroll);
  };
}

export function useScrollMemoryRef<T extends HTMLElement>(fileId: string) {
  const ref = useRef<T | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return attachScrollMemory(el, fileId);
  }, [fileId]);
  return ref;
}

export function MemoizedScrollArea({
  fileId,
  className,
  children,
}: {
  fileId: string;
  className?: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const viewport = root.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    return attachScrollMemory(viewport, fileId);
  }, [fileId]);
  return (
    <div ref={rootRef} className="h-full min-h-0">
      <ScrollArea className={className}>{children}</ScrollArea>
    </div>
  );
}
