import { Undo2Icon } from "lucide-react";
import { useState } from "react";

import {
  threadUndoNoticeSummary,
  undoLatestThreadAction,
  useThreadUndoNotice,
} from "../../hooks/showThreadUndoNotice";
import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { useServerKeybindings } from "../../rpc/serverState";
import { withAppShortcutDefaults } from "../appShortcuts.logic";

/**
 * "Done · ⌘Z to undo" at the bottom of the sidebar for 5 s after Done,
 * snooze, unpin or archive (upstream SidebarThreadUndoNotice, 5781b5240b).
 * It sits in the footer, so it never covers or moves the list; it fades out
 * with its last text instead of blinking away.
 */
export function SidebarThreadUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useServerKeybindings();
  const summary = notice
    ? notice.count === 1
      ? notice.action
      : `${notice.action} ${notice.count}`
    : null;
  // Keeps the last text on screen while it fades out, then unmounts on transitionend.
  const [shownSummary, setShownSummary] = useState(summary);
  if (summary && summary !== shownSummary) setShownSummary(summary);
  const text = summary ?? shownSummary;
  if (!text) return null;

  // Older computers don't send the rule; ⌘Z works anyway (AppShortcuts adds it).
  const shortcut = shortcutLabelForCommand(withAppShortcutDefaults(keybindings), "thread.undo");
  return (
    <div
      role="status"
      aria-live="polite"
      aria-hidden={!summary}
      inert={!summary}
      data-testid="sidebar-thread-undo-notice"
      onTransitionEnd={(event) => {
        if (!summary && event.target === event.currentTarget) setShownSummary(null);
      }}
      className={cn(
        "flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-opacity duration-200 ease-out starting:opacity-0",
        !summary && "opacity-0",
      )}
    >
      <span className="min-w-0 truncate">
        <span className="sr-only">{notice ? threadUndoNoticeSummary(notice) : text}</span>
        <span aria-hidden>{text}</span>
      </span>
      <button
        type="button"
        onClick={() => undoLatestThreadAction()}
        className="ml-auto inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1 font-medium text-foreground/80 hover:bg-accent hover:text-foreground"
        data-testid="sidebar-thread-undo-button"
      >
        <Undo2Icon className="size-3" />
        Undo
        {shortcut ? <span className="text-muted-foreground">{shortcut}</span> : null}
      </button>
    </div>
  );
}
