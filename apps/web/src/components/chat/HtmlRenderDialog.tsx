/** A page full screen, with zoom. Upstream's dialog on our overlay. */
import { MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "../ui/button";
import { HtmlRenderDocument } from "./HtmlRenderDocument";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.25;

export function HtmlRenderDialog(props: {
  readonly html: string;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const { onClose } = props;
  const [zoom, setZoom] = useState(1);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
      role="dialog"
      aria-modal="true"
      aria-label={`${props.title}, full screen`}
    >
      <button
        type="button"
        className="absolute inset-0 z-0 cursor-zoom-out"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="relative z-10 h-[min(86vh,calc(100vh-110px))] w-[92vw] overflow-auto overscroll-contain rounded-lg bg-background p-4 shadow-2xl ring-1 ring-border/70 [container-type:size]">
        <div className="h-[100cqh] w-[100cqw]" style={{ zoom }}>
          <HtmlRenderDocument html={props.html} title={props.title} className="block size-full" />
        </div>
      </div>
      <div className="relative z-10 flex min-w-0 max-w-[92vw] items-center justify-center gap-3 text-xs text-white/80">
        <span className="truncate">{props.title}</span>
        <div className="flex shrink-0 items-center gap-1 [&_button]:text-white/90 [&_button:hover]:bg-white/10 [&_button:hover]:text-white">
          <Button
            aria-label="Zoom out"
            size="icon-xs"
            variant="ghost"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((value) => value - ZOOM_STEP)}
          >
            <MinusIcon />
          </Button>
          <Button aria-label="Reset zoom" size="xs" variant="ghost" onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </Button>
          <Button
            aria-label="Zoom in"
            size="icon-xs"
            variant="ghost"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((value) => value + ZOOM_STEP)}
          >
            <PlusIcon />
          </Button>
          <Button
            ref={closeRef}
            aria-label="Close"
            size="icon-xs"
            variant="ghost"
            onClick={onClose}
          >
            <XIcon />
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
