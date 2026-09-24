/**
 * Chats / Files / Apps — what the sidebar shows under Home and Pinned. One
 * segmented control, always in the same place, so the sidebar is a place to
 * browse the computer, not only a list of chats.
 */
import { FolderTreeIcon, LayoutGridIcon, MessagesSquareIcon } from "lucide-react";
import { memo, type ComponentType } from "react";

import { cn } from "../../lib/utils";
import { SIDEBAR_MODES, type SidebarMode, useNavStore } from "../../navigation/navStore";

const MODES: ReadonlyArray<{
  mode: SidebarMode;
  label: string;
  Icon: ComponentType<{ className?: string }>;
}> = [
  { mode: "chats", label: "Chats", Icon: MessagesSquareIcon },
  { mode: "files", label: "Files", Icon: FolderTreeIcon },
  { mode: "apps", label: "Apps", Icon: LayoutGridIcon },
];

export const SidebarModeSwitch = memo(function SidebarModeSwitch() {
  // "inbox" / "home" (rail modes, or left over from an older version) show
  // the chat list in the standard sidebar, so Chats is the selected tab.
  const storedMode = useNavStore((state) => state.sidebarMode);
  const mode = SIDEBAR_MODES.includes(storedMode) ? storedMode : "chats";
  const setMode = useNavStore((state) => state.setSidebarMode);
  return (
    <div
      role="tablist"
      aria-label="Sidebar"
      className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted/70 p-0.5 dark:bg-muted/50"
    >
      {MODES.map(({ mode: value, label, Icon }) => {
        const active = value === mode;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            data-tour={value}
            aria-selected={active}
            onClick={() => setMode(value)}
            className={cn(
              "flex h-7 min-w-0 cursor-pointer items-center justify-center gap-1.5 rounded-md px-1.5 text-xs font-medium outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-background text-foreground shadow-xs ring-1 ring-border/60 dark:bg-card"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
});
