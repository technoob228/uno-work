/**
 * The four places of Uno Work (simplification 01.10): Chats, Assistants,
 * Files, Apps. One row each, always in the same spot under the header — they
 * replace the Home / Uno / My Uno rows, "More" and the Chats / Files / Apps
 * segmented control.
 *
 * - Chats, Files and Apps choose what the sidebar lists below (the chat list,
 *   the home folder's tree, the apps). Files also opens the Files screen.
 * - Assistants is a screen of its own (`/assistants`).
 */
import { useLocation, useNavigate } from "@tanstack/react-router";
import { BotIcon, FolderTreeIcon, LayoutGridIcon, MessagesSquareIcon } from "lucide-react";
import { memo, type ComponentType } from "react";

import { cn } from "../../lib/utils";
import { useNavStore } from "../../navigation/navStore";
import { activePrimaryNavItem, type PrimaryNavItem } from "./simpleSidebar.logic";
import { useSidebar } from "../ui/sidebar";

const ITEMS: ReadonlyArray<{
  readonly id: PrimaryNavItem;
  readonly label: string;
  readonly Icon: ComponentType<{ className?: string }>;
}> = [
  { id: "chats", label: "Chats", Icon: MessagesSquareIcon },
  { id: "assistants", label: "Assistants", Icon: BotIcon },
  { id: "files", label: "Files", Icon: FolderTreeIcon },
  { id: "apps", label: "Apps", Icon: LayoutGridIcon },
];

export const SidebarPrimaryNav = memo(function SidebarPrimaryNav() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const mode = useNavStore((state) => state.sidebarMode);
  const setMode = useNavStore((state) => state.setSidebarMode);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const active = activePrimaryNavItem({ pathname, mode });

  const open = (id: PrimaryNavItem) => {
    switch (id) {
      case "assistants":
        if (isMobile) setOpenMobile(false);
        void navigate({ to: "/assistants" });
        return;
      case "files":
        setMode("files");
        if (isMobile) setOpenMobile(false);
        void navigate({ to: "/files" });
        return;
      case "apps":
        setMode("apps");
        return;
      case "chats":
        setMode("chats");
        // From the Assistants screen, Chats goes back to where chats start.
        if (pathname.startsWith("/assistants")) void navigate({ to: "/computer" });
        return;
    }
  };

  return (
    <nav aria-label="Uno Work" className="flex flex-col gap-px" data-testid="sidebar-primary-nav">
      {ITEMS.map(({ id, label, Icon }) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            type="button"
            data-tour={id}
            data-testid={`sidebar-nav-${id}`}
            aria-current={isActive ? "page" : undefined}
            onClick={() => open(id)}
            className={cn(
              "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-hidden ring-ring transition-colors focus-visible:ring-2",
              isActive
                ? "bg-sidebar-row-active font-medium text-foreground"
                : "text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </button>
        );
      })}
    </nav>
  );
});
