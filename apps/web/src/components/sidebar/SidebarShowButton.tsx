/**
 * "Show sidebar" in every screen's header while the sidebar is hidden
 * (Rama 26.09: he hid the sidebar on Home and found no way back — screens
 * only had the trigger on phones). On phones it opens the drawer, as before.
 * With the rail layout the rail keeps its own trigger, so nothing here.
 */
import { PanelLeftIcon } from "lucide-react";
import { useEffect } from "react";

import { isElectron } from "../../env";
import { resolveShortcutCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { useServerKeybindings } from "../../rpc/serverState";
import { useNavLayout } from "../../navigation/useNavLayout";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSidebar } from "../ui/sidebar";
import { sidebarToggleLabel, withSidebarToggle } from "./sidebarShortcut";
import { useSidebarDRailVisible } from "./sidebarDState";

export function SidebarShowButton({ className }: { className?: string }) {
  const { open, isMobile, toggleSidebar } = useSidebar();
  const rail = useNavLayout() === "rail";
  // Sidebar D folded to its rail: the rail is the way back.
  const railD = useSidebarDRailVisible();
  const keybindings = useServerKeybindings();
  if (!isMobile && (open || rail || railD)) return null;
  const shortcut = isMobile ? null : sidebarToggleLabel(keybindings);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label="Show sidebar"
            data-testid="sidebar-show"
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              // The window's traffic lights sit where the sidebar was.
              isElectron && !isMobile && "ml-[66px] fullscreen:ml-0",
              className,
            )}
          />
        }
      >
        <PanelLeftIcon className="size-4" />
        {isMobile ? null : <span className="hidden sm:inline">Menu</span>}
      </TooltipTrigger>
      <TooltipPopup side="bottom">Show sidebar{shortcut ? ` · ${shortcut}` : ""}</TooltipPopup>
    </Tooltip>
  );
}

/** ⌘B / Ctrl+B anywhere hides or shows the sidebar (not while a terminal has focus). */
export function SidebarShortcutListener() {
  const { toggleSidebar } = useSidebar();
  const keybindings = useServerKeybindings();
  useEffect(() => {
    const resolved = withSidebarToggle(keybindings);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, resolved, {
        context: { terminalFocus: isTerminalFocused(), terminalOpen: false },
      });
      if (command !== "sidebar.toggle") return;
      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, toggleSidebar]);
  return null;
}
