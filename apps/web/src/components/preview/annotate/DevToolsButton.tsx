/**
 * The browser tab's developer tools button (Misha 28.10): a small </> in the
 * address row instead of the wide "Comment 🐞 5". Off by default on every
 * page — no Comment, no error count, a stranger's site is just the site. On,
 * the page's console and network open below with Comment there (DebugDrawer);
 * the pending notes' count stays on the button so they aren't forgotten.
 */
import { CodeXmlIcon } from "lucide-react";

import { Toggle } from "../../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { usePageToolsStore, usePageToolsTab } from "./pageToolsStore";

export function DevToolsButton({ tabId, disabled }: { tabId: string; disabled: boolean }) {
  const tab = usePageToolsTab(tabId);
  const toggleDevtools = usePageToolsStore((state) => state.toggleDevtools);
  const commentCount = tab.comments.length;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            size="xs"
            pressed={tab.devtools}
            onPressedChange={() => toggleDevtools(tabId)}
            disabled={disabled}
            aria-label="Developer tools"
            data-testid="browser-devtools-button"
            className="gap-0.5 px-1 text-muted-foreground data-pressed:text-foreground"
          >
            <CodeXmlIcon className="size-3.5" />
            {commentCount > 0 ? (
              <span className="text-[10px] tabular-nums text-primary">{commentCount}</span>
            ) : null}
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">
        {tab.devtools
          ? "Close developer tools"
          : "Developer tools: comments for the agent, the page's errors"}
      </TooltipPopup>
    </Tooltip>
  );
}
