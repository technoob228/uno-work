/**
 * "Home" at the top of the sidebar — the computer's desktop (programs, files,
 * apps, what it's doing), one click from anywhere. Always shown: every
 * computer has a Home — a cloud one with its power and App Store, a local one
 * (this Mac, a laptop) with its own programs and load. A cloud computer also
 * carries its live status dot, so "is it on?" is answered without opening
 * anything.
 */
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { HouseIcon } from "lucide-react";
import { memo } from "react";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { cn } from "../../lib/utils";
import { useGoHome } from "../../navigation/useGoHome";
import { POWER_STATE_LABEL, computerPowerState } from "../computer/computerFormat";
import { computerStateQueryOptions } from "../computer/computerQueries";

const DOT = {
  on: "bg-success",
  asleep: "bg-info",
  off: "bg-muted-foreground/50",
  busy: "animate-pulse bg-warning",
  unknown: "bg-muted-foreground/40",
} as const;

export const SidebarComputerRow = memo(function SidebarComputerRow() {
  const machine = useActiveMachine();
  const pathname = useLocation({ select: (location) => location.pathname });
  const goHome = useGoHome();
  const { data } = useQuery(computerStateQueryOptions(machine.environmentId, null));
  const box = machine.isCloud && data?.linked ? (data.box ?? null) : null;
  const state = computerPowerState(box?.status);
  const active = pathname === "/computer";

  return (
    <button
      type="button"
      onClick={goHome}
      className={cn(
        "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-hidden ring-ring transition-colors focus-visible:ring-2",
        active
          ? "bg-sidebar-row-active text-foreground"
          : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      <HouseIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium">Home</span>
      {box ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", DOT[state])} aria-hidden />
          {POWER_STATE_LABEL[state]}
        </span>
      ) : null}
    </button>
  );
});
