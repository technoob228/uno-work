/**
 * The browser tab's developer tools (the </> button, Misha 28.10): Comment
 * first — like DevTools' element picker, a click on the page leaves a note
 * for the agent — then the page's console and network. Dense like DevTools: Console (errors red, warnings amber) and
 * Network (failed requests red), 22px lines. A line's "Ask agent to fix"
 * shows on hover or when it is open (the error with its stack, or the
 * request with what came back, as a card in the chat's composer); "Ask agent
 * to fix all" sends every problem at once. The chevron folds it to its
 * header row; the top edge drags.
 */
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  InfoIcon,
  MessageSquarePlusIcon,
  TrashIcon,
  TriangleAlertIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import {
  allErrorsPayload,
  type ConsoleEntry,
  consolePayload,
  formatDuration,
  isFailedRequest,
  type NetworkEntry,
  requestPayload,
} from "./pageTools.logic";
import { usePageToolsStore, usePageToolsTab } from "./pageToolsStore";
import { useSendToChat } from "./sendToChat";

const MIN_HEIGHT = 96;

export function DebugDrawer({ tabId, pageUrl }: { tabId: string; pageUrl: string }) {
  const tab = usePageToolsTab(tabId);
  const store = usePageToolsStore;
  const height = usePageToolsStore((state) => state.debugHeight);
  const sendToChat = useSendToChat();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    startY: number;
    startHeight: number;
    max: number;
  } | null>(null);
  const errors = tab.console.filter((entry) => entry.level === "error").length;
  const warnings = tab.console.filter((entry) => entry.level === "warn").length;
  const failed = tab.network.filter(isFailedRequest).length;
  const all = allErrorsPayload({
    page: pageUrl,
    console: tab.console,
    network: tab.network,
  });
  // The same N as the count on the Comment button.
  const problems = errors + failed;
  const open = tab.debugOpen;

  const onResizeDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const column = rootRef.current?.parentElement?.getBoundingClientRect().height ?? 600;
    dragRef.current = {
      startY: event.clientY,
      startHeight: height,
      max: column * 0.75,
    };
  };
  const onResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = drag.startHeight + (drag.startY - event.clientY);
    store.getState().setDebugHeight(Math.min(drag.max, Math.max(MIN_HEIGHT, next)));
  };
  const onResizeUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      ref={rootRef}
      className="relative flex shrink-0 flex-col border-t border-border bg-card text-xs"
      style={open ? { height } : undefined}
      data-testid="browser-debug-drawer"
    >
      <div
        hidden={!open}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize"
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize hover:bg-primary/20"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
      />
      <div
        className={cn(
          "@container/devtools flex h-8 shrink-0 items-center gap-0.5 px-1.5",
          open && "border-b border-border",
        )}
      >
        {/* A narrow panel keeps every button: the labels go, the icons and counts stay. */}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
          <button
            type="button"
            aria-pressed={tab.commenting}
            onClick={() => store.getState().toggleMode(tabId)}
            title="Click anything on the page to leave a note for the agent (C)"
            data-testid="browser-comment-button"
            className={cn(
              "inline-flex h-6 shrink-0 items-center gap-1 rounded px-1.5 font-sans text-xs",
              tab.commenting
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <MessageSquarePlusIcon className="size-3.5" />
            <span className="hidden @md/devtools:inline">Comment</span>
          </button>
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
          <TabButton
            active={open && tab.debugTab === "console"}
            onClick={() => store.getState().patch(tabId, { debugTab: "console", debugOpen: true })}
          >
            Console
            {errors > 0 ? <Count tone="error">{errors}</Count> : null}
            {warnings > 0 ? <Count tone="warn">{warnings}</Count> : null}
          </TabButton>
          <TabButton
            active={open && tab.debugTab === "network"}
            onClick={() => store.getState().patch(tabId, { debugTab: "network", debugOpen: true })}
          >
            Network
            {failed > 0 ? <Count tone="error">{failed}</Count> : null}
          </TabButton>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            size="xs"
            variant="outline"
            disabled={!all}
            onClick={() => all && sendToChat(all, "Fix these errors on the page.")}
            title="Ask the agent to fix every error on the page"
            className="shrink-0"
            data-testid="browser-send-all-errors"
          >
            <WrenchIcon />
            <span className="hidden @md/devtools:inline">Fix all</span>
            {problems > 0 ? <span className="tabular-nums">{problems}</span> : null}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => store.getState().resetLogs(tabId)}
            aria-label="Clear"
            title="Clear"
          >
            <TrashIcon />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => store.getState().patch(tabId, { debugOpen: !open })}
            aria-label={open ? "Fold" : "Unfold"}
            title={open ? "Fold" : "Unfold"}
            data-testid="browser-debug-fold"
          >
            {open ? <ChevronDownIcon /> : <ChevronUpIcon />}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => store.getState().toggleDevtools(tabId)}
            aria-label="Close developer tools"
            title="Close developer tools"
            data-testid="browser-devtools-close"
          >
            <XIcon />
          </Button>
        </div>
      </div>
      <div hidden={!open} className="min-h-0 flex-1 overflow-y-auto font-mono text-[11px]">
        {tab.debugTab === "console" ? (
          tab.console.length === 0 ? (
            <Empty text="Nothing in the console yet." />
          ) : (
            tab.console.map((entry) => (
              <ConsoleRow
                key={entry.id}
                entry={entry}
                onFix={() =>
                  sendToChat(
                    consolePayload({ page: pageUrl, entry }),
                    entry.level === "warn" ? "Look at this warning." : "Fix this error.",
                  )
                }
              />
            ))
          )
        ) : tab.network.length === 0 ? (
          <Empty text="No requests yet. Reload the page to see them all." />
        ) : (
          <>
            <div className="sticky top-0 z-[1] flex h-[22px] items-center gap-2 border-b border-border bg-card px-2.5 font-sans text-[10.5px] text-muted-foreground">
              <span className="w-10 shrink-0">Method</span>
              <span className="min-w-0 flex-1">Address</span>
              <span className="w-10 shrink-0 text-right">Status</span>
              <span className="w-12 shrink-0">Type</span>
              <span className="w-12 shrink-0 text-right">Time</span>
            </div>
            {tab.network.map((entry) => (
              <NetworkRow
                key={entry.id}
                entry={entry}
                onFix={() =>
                  sendToChat(requestPayload({ page: pageUrl, entry }), "Fix this request.")
                }
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs",
        active
          ? "bg-accent font-medium text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** "ⓧ 3", "⚠ 1" — colour on the icon and the number, no fill. */
function Count({ tone, children }: { tone: "error" | "warn"; children: React.ReactNode }) {
  const Icon = tone === "error" ? CircleAlertIcon : TriangleAlertIcon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums",
        tone === "error" ? "text-destructive" : "text-amber-600 dark:text-amber-400",
      )}
    >
      <Icon className="size-3" />
      {children}
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-3 py-3 font-sans text-xs text-muted-foreground">{text}</div>;
}

/** On hover of its line, or while the line is open. */
function FixButton({ onClick, shown }: { onClick: () => void; shown: boolean }) {
  return (
    <span
      className={cn(
        "absolute top-0 right-1 flex h-[22px] items-center bg-gradient-to-l from-card from-75% pl-4",
        shown ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
      )}
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        className="inline-flex h-[18px] cursor-pointer items-center gap-1 rounded border border-border bg-background px-1.5 font-sans text-[10.5px] font-medium text-foreground hover:bg-accent"
      >
        <WrenchIcon className="size-2.5" />
        Ask agent to fix
      </button>
    </span>
  );
}

function ConsoleRow({ entry, onFix }: { entry: ConsoleEntry; onFix: () => void }) {
  const [open, setOpen] = useState(false);
  const problem = entry.level === "error" || entry.level === "warn";
  const Icon =
    entry.level === "error"
      ? CircleAlertIcon
      : entry.level === "warn"
        ? TriangleAlertIcon
        : InfoIcon;
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div
      className={cn(
        "group relative border-b border-border/60",
        entry.level === "error" && "bg-destructive/[0.05] text-destructive",
        entry.level === "warn" && "bg-amber-500/[0.07] text-amber-800 dark:text-amber-300",
        !problem && "text-foreground/85",
      )}
      data-level={entry.level}
    >
      <div
        className="flex h-[22px] cursor-pointer items-center gap-1.5 px-2"
        onClick={() => setOpen((value) => !value)}
      >
        <Chevron className="size-3 shrink-0 opacity-50" />
        <Icon className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{entry.message}</span>
        {entry.source ? (
          <span className="shrink-0 text-[10.5px] text-muted-foreground">{entry.source}</span>
        ) : null}
      </div>
      {problem ? <FixButton onClick={onFix} shown={open} /> : null}
      {open ? (
        <pre className="overflow-x-auto px-9 pb-1.5 text-[10.5px] leading-relaxed whitespace-pre-wrap opacity-85">
          {entry.stack && !entry.stack.includes(entry.message)
            ? `${entry.message}\n${entry.stack}`
            : (entry.stack ?? entry.message)}
        </pre>
      ) : null}
    </div>
  );
}

function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function NetworkRow({ entry, onFix }: { entry: NetworkEntry; onFix: () => void }) {
  const [open, setOpen] = useState(false);
  const failed = isFailedRequest(entry);
  const hasMore = Boolean(entry.requestBody || entry.responseBody);
  return (
    <div
      className={cn(
        "group relative border-b border-border/60",
        failed ? "bg-destructive/[0.05] text-destructive" : "text-foreground/85",
      )}
    >
      <div
        className={cn("flex h-[22px] items-center gap-2 px-2.5", hasMore && "cursor-pointer")}
        onClick={() => hasMore && setOpen((value) => !value)}
        title={entry.url}
      >
        <span className="w-10 shrink-0 font-semibold">{entry.method}</span>
        <span className="min-w-0 flex-1 truncate">{pathOf(entry.url)}</span>
        <span className="w-10 shrink-0 text-right tabular-nums">
          {entry.status === null ? "failed" : entry.status}
        </span>
        <span className="w-12 shrink-0 text-muted-foreground">{entry.type}</span>
        <span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
          {formatDuration(entry.durationMs)}
        </span>
      </div>
      {failed ? <FixButton onClick={onFix} shown={open} /> : null}
      {open ? (
        <div className="space-y-1 px-2.5 pb-2 text-[10.5px]">
          {entry.requestBody ? (
            <div>
              <div className="font-sans text-muted-foreground">Sent</div>
              <pre className="overflow-x-auto whitespace-pre-wrap">{entry.requestBody}</pre>
            </div>
          ) : null}
          {entry.responseBody ? (
            <div>
              <div className="font-sans text-muted-foreground">
                Answer · {entry.status} {entry.statusText}
              </div>
              <pre className="overflow-x-auto whitespace-pre-wrap">{entry.responseBody}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
