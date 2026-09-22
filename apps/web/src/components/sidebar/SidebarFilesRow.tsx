/**
 * "Files" in the sidebar — the computer's files, next to "This computer".
 * Always shown: every machine running Uno Work has a home folder.
 */
import { Link, useLocation } from "@tanstack/react-router";
import { FolderOpenIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { useSidebar } from "../ui/sidebar";

export const SidebarFilesRow = memo(function SidebarFilesRow() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const active = pathname === "/files";

  return (
    <Link
      to="/files"
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
      <FolderOpenIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium">Files</span>
    </Link>
  );
});
