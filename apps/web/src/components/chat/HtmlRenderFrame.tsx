/**
 * A page the agent showed in the chat: read from its computer over the same
 * socket as the chat (local, cloud or web, it all goes the same way), fitted
 * to its height, with a button to open it full screen.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { FILESYSTEM_READ_FILE_HARD_MAX_BYTES } from "@t3tools/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFrameHeight,
  type HtmlRenderReference,
} from "@t3tools/shared/htmlRender";
import { useQuery } from "@tanstack/react-query";
import { Maximize2Icon } from "lucide-react";
import { useCallback, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HtmlRenderDialog } from "./HtmlRenderDialog";
import { HtmlRenderDocument } from "./HtmlRenderDocument";

/**
 * The list unmounts rows out of view. A row that comes back keeps the height
 * the page measured, so the chat doesn't jump.
 */
const measuredHeights = new Map<string, number>();
const MAX_MEASURED_HEIGHTS = 200;

function rememberHeight(attachmentId: string, height: number) {
  measuredHeights.delete(attachmentId);
  measuredHeights.set(attachmentId, height);
  if (measuredHeights.size > MAX_MEASURED_HEIGHTS) {
    const oldest = measuredHeights.keys().next().value;
    if (oldest !== undefined) measuredHeights.delete(oldest);
  }
}

async function readPage(environmentId: EnvironmentId, path: string): Promise<string> {
  const api = readEnvironmentApi(environmentId);
  if (!api) throw new Error("This computer isn't connected.");
  const file = await api.filesystem.readFile({
    path,
    maxBytes: FILESYSTEM_READ_FILE_HARD_MAX_BYTES,
  });
  if (file.truncated || file.encoding !== "utf8") throw new Error("This page can't be shown.");
  return file.content;
}

export function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId | undefined;
  readonly htmlRender: HtmlRenderReference;
}) {
  const { environmentId, htmlRender } = props;
  const { attachmentId, path, title } = htmlRender;
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  const [contentHeight, setContentHeight] = useState(() => measuredHeights.get(attachmentId));
  const [expanded, setExpanded] = useState(false);
  const page = useQuery({
    queryKey: ["htmlRender", environmentId, attachmentId],
    queryFn: () => readPage(environmentId!, path),
    enabled: environmentId !== undefined,
    // A page never changes: one read for as long as it's near.
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: 1,
  });
  const observeBox = useCallback((box: HTMLDivElement | null) => {
    if (box === null) return;
    setWidth(box.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  const onContentHeight = useCallback(
    (height: number) => {
      rememberHeight(attachmentId, height);
      setContentHeight(height);
    },
    [attachmentId],
  );
  const height = htmlRenderFrameHeight(htmlRender, width, contentHeight);

  if (page.isError) {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground"
        data-testid="html-render-unavailable"
      >
        <span className="min-w-0 truncate">Couldn't open “{title}”.</span>
        <Button size="xs" variant="ghost" onClick={() => void page.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div
      ref={observeBox}
      className="group/html-render relative"
      style={{ height }}
      data-testid="html-render"
    >
      {page.data !== undefined ? (
        <>
          <HtmlRenderDocument
            key={attachmentId}
            html={page.data}
            title={title}
            className="block size-full"
            onContentHeight={onContentHeight}
          />
          <div className="absolute end-2 top-2 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/html-render:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Open full screen"
                    size="icon-xs"
                    variant="outline"
                    onClick={() => setExpanded(true)}
                  />
                }
              >
                <Maximize2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="left">Open full screen</TooltipPopup>
            </Tooltip>
          </div>
          {expanded ? (
            <HtmlRenderDialog html={page.data} title={title} onClose={() => setExpanded(false)} />
          ) : null}
        </>
      ) : (
        <div
          className="size-full animate-pulse rounded-lg bg-muted/40"
          aria-label={`Loading ${title}`}
        />
      )}
    </div>
  );
}
