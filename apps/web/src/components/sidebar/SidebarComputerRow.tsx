/**
 * The "This computer" entry at the top of the sidebar — the way into the
 * computer's own screen (monitor, apps, what it's doing), like the disk icon
 * on a desktop. It carries a live status dot so "is it on?" is answered
 * without opening anything. Hidden until the daemon has an Uno account: there
 * is nothing to show about a computer the app cannot see.
 */
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { MonitorIcon } from "lucide-react";
import { memo } from "react";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useActiveMachine } from "../../hooks/useActiveMachine";
import { cn } from "../../lib/utils";
import { useStore } from "../../store";
import { POWER_STATE_LABEL, computerPowerState } from "../computer/computerFormat";
import { computerStateQueryOptions } from "../computer/computerQueries";
import { useSidebar } from "../ui/sidebar";

const DOT = {
  on: "bg-success",
  asleep: "bg-info",
  off: "bg-muted-foreground/50",
  busy: "animate-pulse bg-warning",
  unknown: "bg-muted-foreground/40",
} as const;

export const SidebarComputerRow = memo(function SidebarComputerRow() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const environmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const machine = useActiveMachine();
  const { data } = useQuery(computerStateQueryOptions(environmentId, null));

  // A local computer (this Mac, a laptop) has no cloud home screen: chats,
  // Files and Terminal cover it.
  if (!machine.isCloud || !data?.linked) return null;
  const state = computerPowerState(data.box?.status);
  const active = pathname === "/computer";

  return (
    <Link
      to="/computer"
      onClick={() => {
        if (isMobile) setOpenMobile(false);
      }}
      className={cn(
        "flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-sm outline-hidden ring-ring transition-colors focus-visible:ring-2",
        active
          ? "bg-sidebar-row-active text-foreground"
          : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      <MonitorIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium">Home</span>
      {data.box ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", DOT[state])} aria-hidden />
          {POWER_STATE_LABEL[state]}
        </span>
      ) : null}
    </Link>
  );
});
