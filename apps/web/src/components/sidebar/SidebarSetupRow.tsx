/**
 * "Set up 3/8" / "Finish setup · 2 left" at the top of the sidebar while the
 * guided setup (`/setup`) is open or has skipped steps; gone once it's all
 * done or hidden. Progress is the machine's (`settings.setup`).
 */
import { useLocation, useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { setupSidebarState } from "../setup/setupModel";
import { useSetupTourStore } from "../setup/SetupTour";
import { useSetupProgress, useUpdateSetupProgress } from "../setup/useSetupProgress";
import { useSidebar } from "../ui/sidebar";

function Ring({ ratio }: { ratio: number }) {
  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden>
      <circle cx="8" cy="8" r={radius} fill="none" className="stroke-primary/20" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        className="stroke-primary"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0, ratio)))}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

export const SidebarSetupRow = memo(function SidebarSetupRow() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const routeStep = useLocation({
    select: (location): string => {
      if (location.pathname !== "/setup") return "";
      const step = (location.search as { readonly step?: unknown }).step;
      return typeof step === "string" ? step : "";
    },
  });
  const tourStep = useSetupTourStore((store) => store.step);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const progress = useSetupProgress();
  const update = useUpdateSetupProgress();
  const state = setupSidebarState(progress, {
    onWelcome: routeStep === "welcome",
    tour: tourStep ?? (routeStep === "tour-done" ? "done" : null),
  });
  if (state.hidden) return null;
  const active = pathname === "/setup";
  return (
    <div
      className={cn(
        "group/setup flex h-9 w-full items-center rounded-lg",
        active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-sidebar-row-hover",
      )}
    >
      <button
        type="button"
        onClick={() => {
          if (isMobile) setOpenMobile(false);
          void navigate({ to: "/setup", search: { step: state.step } });
        }}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2 text-left text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
        aria-current={active ? "page" : undefined}
        data-testid="sidebar-setup"
      >
        <Ring ratio={state.ratio} />
        <span className="min-w-0 flex-1 truncate font-medium">{state.label}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{state.meta}</span>
      </button>
      {state.label === "Finish setup" ? (
        <button
          type="button"
          aria-label="Hide setup"
          onClick={() => void update((current) => ({ ...current, dismissed: true }))}
          className="mr-1 hidden size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted group-hover/setup:flex"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
});
