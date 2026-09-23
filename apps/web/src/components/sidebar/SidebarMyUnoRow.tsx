/**
 * "My Uno" under Home in the sidebar — the whole account in one window:
 * every computer and what it's for, sites, cloud, plan and billing. Shown
 * wherever this interface can reach the account (app.uno4.work, the desktop
 * app); on a computer's own address the account isn't here, so neither is
 * the row.
 */
import { useLocation, useNavigate } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";
import { memo } from "react";

import { accountTransport } from "../../account/unoAccount";
import { cn } from "../../lib/utils";
import { useSidebar } from "../ui/sidebar";

export const SidebarMyUnoRow = memo(function SidebarMyUnoRow() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  if (accountTransport() === "none") return null;
  const active = pathname === "/my-uno";
  return (
    <button
      type="button"
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        void navigate({ to: "/my-uno" });
      }}
      className={cn(
        "flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-hidden ring-ring transition-colors focus-visible:ring-2",
        active
          ? "bg-sidebar-row-active text-foreground"
          : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
      )}
      aria-current={active ? "page" : undefined}
      data-testid="sidebar-my-uno"
    >
      <LayoutGridIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium">My Uno</span>
    </button>
  );
});
