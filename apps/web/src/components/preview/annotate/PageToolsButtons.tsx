/**
 * Comment (C) and Errors (D) in the browser tab's address row (w0138): two
 * toggles of one look, with words — "Comment", "Errors · 5". The count is
 * there even while the errors panel is closed.
 */
import { BugIcon, MessageSquarePlusIcon } from "lucide-react";

import { cn } from "../../../lib/utils";
import { Toggle } from "../../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { debugBadge } from "./pageTools.logic";
import { usePageToolsStore, usePageToolsTab } from "./pageToolsStore";

const TOGGLE =
  "gap-1 px-1.5 text-xs font-normal text-muted-foreground data-pressed:text-foreground";

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
            <Toggle
              size="xs"
              pressed={tab.commenting}
              onPressedChange={() => toggleCommenting(tabId)}
              disabled={disabled}
              data-testid="browser-comment-button"
              className={TOGGLE}
            >
              <MessageSquarePlusIcon className="size-3.5" />
              Comment
              {commentCount > 0 ? (
                <span className="tabular-nums text-primary">· {commentCount}</span>
              ) : null}
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          Click anything on the page to leave a note for the agent{" "}
          <kbd className="ml-1 opacity-70">C</kbd>
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              size="xs"
              pressed={tab.debugOpen}
              onPressedChange={() => toggleDebug(tabId)}
              disabled={disabled}
              data-testid="browser-debug-button"
              className={TOGGLE}
            >
              <BugIcon className="size-3.5" />
              Errors
              {badge ? (
                <span
                  className={cn(
                    "font-medium tabular-nums",
                    badge.tone === "error"
                      ? "text-destructive"
                      : "text-amber-600 dark:text-amber-400",
                  )}
                  data-testid="browser-debug-badge"
                >
                  · {badge.count}
                </span>
              ) : null}
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          The page's console and network <kbd className="ml-1 opacity-70">D</kbd>
        </TooltipPopup>
      </Tooltip>
    </>
  );
}
