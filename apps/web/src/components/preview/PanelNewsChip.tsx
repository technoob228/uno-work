import { PanelRightOpenIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { usePreviewPane } from "./PreviewPaneContext";

/**
 * Above the composer, on a phone only: "the agent opened X — View". There the
 * panel can't sit beside the chat (agent flow 25.10: the chat shrank to one
 * letter per line), so what the agent opens waits here instead of popping a
 * full-screen sheet over its own answer. View opens the sheet on that tab.
 */
export function ComposerPanelNewsChip() {
  const { panelIsSheet, unseenTab, setOpen, clearUnseen } = usePreviewPane();
  if (!panelIsSheet || !unseenTab) return null;
  return (
    <div
      className="mb-2 flex items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2 text-sm shadow-xs"
      data-testid="panel-news-chip"
    >
      <PanelRightOpenIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        Opened <span className="font-medium">{unseenTab.name}</span>
      </span>
      <Button size="sm" onClick={() => setOpen(true)} data-testid="panel-news-view">
        View
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={clearUnseen}
        aria-label="Dismiss"
        className="shrink-0"
      >
        <XIcon />
      </Button>
    </div>
  );
}
