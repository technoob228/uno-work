/**
 * Comment (C) and Debug (D) in the browser tab's address row (w0138). Debug
 * carries the count of errors (or warnings) even while its panel is closed.
 */
import { BugIcon, MessageSquarePlusIcon } from "lucide-react";

import { cn } from "../../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { debugBadge } from "./pageTools.logic";
import { usePageToolsStore, usePageToolsTab } from "./pageToolsStore";

export function PageToolsButtons({ tabId, disabled }: { tabId: string; disabled: boolean }) {
  const tab = usePageToolsTab(tabId);
  const toggleCommenting = usePageToolsStore((state) => state.toggleCommenting);
  const toggleDebug = usePageToolsStore((state) => state.toggleDebug);
  const badge = debugBadge(tab.console, tab.network);
  const commentCount = tab.comments.length;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => toggleCommenting(tabId)}
              disabled={disabled}
              aria-pressed={tab.commenting}
              aria-label="Comment"
              data-testid="browser-comment-button"
              className={cn(
                "relative inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
                tab.commenting &&
                  "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
              )}
            >
              <MessageSquarePlusIcon className="size-3.5" />
              {commentCount > 0 && !tab.commenting ? (
                <span className="absolute -top-1 -right-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-semibold text-primary-foreground">
                  {commentCount}
                </span>
              ) : null}
            </button>
          }
        />
        <TooltipPopup side="bottom">
          Comment on the page <kbd className="ml-1 opacity-70">C</kbd>
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => toggleDebug(tabId)}
              disabled={disabled}
              aria-pressed={tab.debugOpen}
              aria-label={
                badge
                  ? `Debug, ${badge.count} ${badge.tone === "error" ? "errors" : "warnings"}`
                  : "Debug"
              }
              data-testid="browser-debug-button"
              className={cn(
                "relative inline-flex h-6 shrink-0 cursor-pointer items-center justify-center gap-1 rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
                tab.debugOpen && "bg-accent text-foreground",
              )}
            >
              <BugIcon className="size-3.5" />
              {badge ? (
                <span
                  className={cn(
                    "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
                    badge.tone === "error"
                      ? "bg-destructive text-white"
                      : "bg-amber-500 text-white",
                  )}
                  data-testid="browser-debug-badge"
                >
                  {badge.count}
                </span>
              ) : null}
            </button>
          }
        />
        <TooltipPopup side="bottom">
          Console and network <kbd className="ml-1 opacity-70">D</kbd>
        </TooltipPopup>
      </Tooltip>
    </>
  );
}
