/**
 * "Terminal" in the sidebar of a local computer (this Mac, a laptop), where
 * the cloud home screen with its Terminal program is hidden. Opens a chat in
 * the home folder with its terminal drawer open.
 */
import { SquareTerminalIcon } from "lucide-react";
import { memo, useState } from "react";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { cn } from "../../lib/utils";
import { useHomeLaunchers } from "../computer/useHomeLaunchers";
import { useSidebar } from "../ui/sidebar";

export const SidebarTerminalRow = memo(function SidebarTerminalRow() {
  const machine = useActiveMachine();
  const launchers = useHomeLaunchers(machine.environmentId);
  const { isMobile, setOpenMobile } = useSidebar();
  const [busy, setBusy] = useState(false);

  if (machine.isCloud) return null;

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        setBusy(true);
        void launchers.openTerminal().finally(() => setBusy(false));
      }}
      className={cn(
        "flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm text-muted-foreground outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-foreground focus-visible:ring-2 disabled:cursor-wait",
      )}
    >
      <SquareTerminalIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium">Terminal</span>
    </button>
  );
});
