/**
 * The one Comment button in the browser tab's address row (w0138, Misha
 * 16.10): a single mode like Codex — on, click anything on the page to leave
 * a note, and the page's console and network show below; off, the page is
 * just the page. No second button, no settings. The page's error count is on
 * the button even while the mode is off, so a broken page is seen at once.
 */
import { BugIcon, MessageSquarePlusIcon } from "lucide-react";

import { cn } from "../../../lib/utils";
import { Toggle } from "../../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { debugBadge } from "./pageTools.logic";
import { usePageToolsStore, usePageToolsTab } from "./pageToolsStore";

export function PageToolsButtons({ tabId, disabled }: { tabId: string; disabled: boolean }) {
  const tab = usePageToolsTab(tabId);
  const toggleMode = usePageToolsStore((state) => state.toggleMode);
  const badge = debugBadge(tab.console, tab.network);
  const commentCount = tab.comments.length;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            size="xs"
            pressed={tab.commenting}
            onPressedChange={() => toggleMode(tabId)}
            disabled={disabled}
            data-testid="browser-comment-button"
            className="gap-1 px-1.5 text-xs font-normal text-muted-foreground data-pressed:text-foreground"
          >
            <MessageSquarePlusIcon className="size-3.5" />
            Comment
            {commentCount > 0 ? (
              <span className="tabular-nums text-primary">· {commentCount}</span>
            ) : null}
            {badge ? (
              <span
                className={cn(
                  "ml-0.5 inline-flex items-center gap-0.5 font-medium tabular-nums",
                  badge.tone === "error" ? "text-destructive" : "text-amber-600 dark:text-amber-400",
                )}
                title={`${badge.count} ${badge.tone === "error" ? "errors" : "warnings"} on the page`}
                data-testid="browser-debug-badge"
              >
                <BugIcon className="size-3" />
                {badge.count}
              </span>
            ) : null}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        Leave notes for the agent right on the page, and see its errors{" "}
        <kbd className="ml-1 opacity-70">C</kbd>
      </TooltipPopup>
    </Tooltip>
  );
}
