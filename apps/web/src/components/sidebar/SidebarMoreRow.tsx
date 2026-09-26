/**
 * Newcomer sidebar (meeting feedback 25.09: "too much, one more cloud
 * interface"): after the goal-first start the sidebar shows the assistant,
 * Home and the chats. Files, Apps and My Uno wait under "More" — one click
 * brings the full sidebar back, and it stays.
 */
import { ChevronDownIcon } from "lucide-react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { goalState } from "../setup/goals";
import { useSetupProgress } from "../setup/useSetupProgress";

const MORE_KEY = "uno:sidebar:more-open";

/** True while the sidebar should stay simple (a goal-first newcomer who hasn't opened More). */
export function useSimpleSidebar(): { simple: boolean; openMore: () => void } {
  const progress = useSetupProgress();
  const [open, setOpen] = useLocalStorage(MORE_KEY, false, Schema.Boolean);
  const newcomer = goalState(progress).goal !== null;
  return { simple: newcomer && !open, openMore: () => setOpen(true) };
}

export function SidebarMoreRow({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      data-testid="sidebar-more"
    >
      <ChevronDownIcon className="size-3.5" />
      More: Files, Apps, My Uno
    </button>
  );
}
