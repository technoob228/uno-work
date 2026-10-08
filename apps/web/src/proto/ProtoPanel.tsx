/**
 * Sidebar prototype (w0115, NOT FOR MERGE): the floating switcher — sidebar
 * variant (A–E) and the multi-computer mode ((А) one computer / (Б) all
 * together). Folds into a small pill so it never covers the screen for long.
 */
import { ChevronDownIcon, ChevronUpIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { MODES, VARIANTS, useProtoStore } from "./protoState";

export default function ProtoPanel() {
  const variant = useProtoStore((state) => state.variant);
  const mode = useProtoStore((state) => state.mode);
  const setVariant = useProtoStore((state) => state.setVariant);
  const setMode = useProtoStore((state) => state.setMode);
  const [open, setOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= 700,
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Folds by itself as soon as the person works with the app, so it never sits on the composer.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);
  const current = VARIANTS.find((item) => item.id === variant)!;
  const currentMode = MODES.find((item) => item.id === mode)!;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="proto-panel-pill"
        className="fixed right-3 bottom-3 z-[90] inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border border-border bg-popover px-3.5 text-xs font-medium text-popover-foreground shadow-lg hover:bg-accent max-md:bottom-20"
      >
        <SlidersHorizontalIcon className="size-3.5" />
        Variant {variant} · {mode === "one" ? "(А)" : "(Б)"}
        <ChevronUpIcon className="size-3.5 text-muted-foreground" />
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Prototype variants"
      data-testid="proto-panel"
      className="fixed right-3 bottom-3 z-[90] w-[min(23rem,calc(100vw-1.5rem))] rounded-2xl border border-border bg-popover p-3 text-popover-foreground shadow-xl max-md:bottom-20"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Prototype · mock data
        </span>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Fold the panel"
          className="ml-auto inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronDownIcon className="size-4" />
        </button>
      </div>

      <p className="mb-1.5 text-xs font-medium">Sidebar</p>
      <div className="grid grid-cols-5 gap-1" role="radiogroup" aria-label="Sidebar variant">
        {VARIANTS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={variant === item.id}
            onClick={() => setVariant(item.id)}
            data-testid={`proto-variant-${item.id}`}
            className={cn(
              "flex cursor-pointer flex-col items-center rounded-lg border px-1 py-1.5 text-center transition-colors",
              variant === item.id
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <span className="text-sm font-semibold">{item.id}</span>
            <span className="text-[10px] leading-tight">{item.name}</span>
          </button>
        ))}
      </div>
      <p className="mt-1.5 mb-3 text-xs leading-snug text-muted-foreground">{current.hint}</p>

      <p className="mb-1.5 text-xs font-medium">Several computers</p>
      <div className="grid grid-cols-2 gap-1" role="radiogroup" aria-label="Computers mode">
        {MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={mode === item.id}
            onClick={() => setMode(item.id)}
            data-testid={`proto-mode-${item.id}`}
            className={cn(
              "cursor-pointer rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors",
              mode === item.id
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {item.name}
          </button>
        ))}
      </div>
      <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{currentMode.hint}</p>
    </div>
  );
}
