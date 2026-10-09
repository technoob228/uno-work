/**
 * Demo mode: the small floating switcher of the variants (V1–V4). Folds into
 * a pill as soon as the person works with the app, so it never covers the
 * composer for long. Only in the demo (main.tsx loads it with ?demo=heavy).
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import type { getRouter } from "../router";
import { useStore } from "../store";
import { DEMO_VARIANTS, useDemoStore } from "./demoFlag";
import { machineByEnv } from "./heavyFixtures";

type DemoRouter = ReturnType<typeof getRouter>;

/** A chat opened from the joined list makes its computer the active one. */
function useActiveFollowsOpenChat(router: DemoRouter) {
  useEffect(() => {
    const sync = () => {
      const environmentId = router.state.location.pathname.split("/")[1] ?? "";
      if (!machineByEnv(environmentId)) return;
      if (useStore.getState().activeEnvironmentId !== environmentId) {
        useStore.getState().setActiveEnvironmentId(environmentId as EnvironmentId);
      }
    };
    sync();
    return router.subscribe("onResolved", sync);
  }, [router]);
}

export default function DemoPanel({ router }: { router: DemoRouter }) {
  useActiveFollowsOpenChat(router);
  const variant = useDemoStore((state) => state.variant);
  const setVariant = useDemoStore((state) => state.setVariant);
  const [open, setOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= 700,
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
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
  const current = DEMO_VARIANTS.find((item) => item.id === variant)!;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="demo-panel-pill"
        className="fixed right-3 bottom-3 z-[90] inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border border-border bg-popover px-3.5 text-xs font-medium text-popover-foreground shadow-lg hover:bg-accent max-md:bottom-20"
      >
        <SlidersHorizontalIcon className="size-3.5" />
        {variant} · {current.name}
        <ChevronUpIcon className="size-3.5 text-muted-foreground" />
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Demo variants"
      data-testid="demo-panel"
      className="fixed right-3 bottom-3 z-[90] w-[min(24rem,calc(100vw-1.5rem))] rounded-2xl border border-border bg-popover p-3 text-popover-foreground shadow-xl max-md:bottom-20"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Demo · made-up data · heavy usage
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
      <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label="Variant">
        {DEMO_VARIANTS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={variant === item.id}
            onClick={() => setVariant(item.id)}
            data-testid={`demo-variant-${item.id}`}
            className={cn(
              "flex cursor-pointer flex-col items-center rounded-lg border px-1 py-1.5 text-center transition-colors",
              variant === item.id
                ? "border-foreground/80 bg-foreground/5 text-foreground"
                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <span className="text-sm font-semibold">{item.id}</span>
            <span className="text-[10px] leading-tight">{item.name}</span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs leading-snug text-muted-foreground">{current.hint}</p>
    </div>
  );
}
