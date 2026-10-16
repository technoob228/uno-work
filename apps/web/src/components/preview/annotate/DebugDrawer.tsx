/**
 * Debug (D) — the drawer at the bottom of a browser tab (w0138): the page's
 * Console (errors red, warnings amber) and Network (failed requests red).
 * Each problem has "Ask agent to fix" (the error with its stack, or the
 * request with what came back, as a card in the chat's composer); "Send all
 * errors" sends every one at once. "Agent sees the console" — the agent can
 * read this console when it works in this browser.
 */
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  InfoIcon,
  TrashIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "../../../lib/utils";
import { Switch } from "../../ui/switch";
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

export function DebugDrawer({ tabId, pageUrl }: { tabId: string; pageUrl: string }) {
  const tab = usePageToolsTab(tabId);
  const store = usePageToolsStore;
  const agentSeesConsole = usePageToolsStore((state) => state.agentSeesConsole);
  const sendToChat = useSendToChat();
  const errors = tab.console.filter((entry) => entry.level === "error").length;
  const warnings = tab.console.filter((entry) => entry.level === "warn").length;
  const failed = tab.network.filter(isFailedRequest).length;
  const all = allErrorsPayload({ page: pageUrl, console: tab.console, network: tab.network });

  return (
    <div
      className="flex h-[42%] min-h-40 shrink-0 flex-col border-t border-border bg-card text-xs"
      data-testid="browser-debug-drawer"
    >
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-1.5">
        <TabButton
          active={tab.debugTab === "console"}
          onClick={() => store.getState().patch(tabId, { debugTab: "console" })}
        >
          Console
          {errors > 0 ? <Count tone="error">{errors}</Count> : null}
          {warnings > 0 ? <Count tone="warn">{warnings}</Count> : null}
        </TabButton>
        <TabButton
          active={tab.debugTab === "network"}
          onClick={() => store.getState().patch(tabId, { debugTab: "network" })}
        >
          Network
          {failed > 0 ? <Count tone="error">{failed}</Count> : null}
        </TabButton>
        <label
          className="ml-auto flex cursor-pointer items-center gap-1.5 px-1.5 text-[11px] whitespace-nowrap text-muted-foreground"
          title="When the agent works in this browser, it can read this console"
        >
          <Switch
            checked={agentSeesConsole}
            onCheckedChange={(checked) => store.getState().setAgentSeesConsole(checked)}
            className="[--thumb-size:--spacing(3)] sm:[--thumb-size:--spacing(3)]"
            data-testid="browser-agent-sees-console"
          />
          Agent sees the console
        </label>
        <button
          type="button"
          disabled={!all}
          onClick={() => all && sendToChat(all, "Fix these problems on the page.")}
          className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-foreground hover:bg-accent disabled:cursor-default disabled:opacity-40"
          data-testid="browser-send-all-errors"
        >
          <WrenchIcon className="size-3" />
          Send all errors
        </button>
        <button
          type="button"
          onClick={() => store.getState().resetLogs(tabId)}
          aria-label="Clear"
          title="Clear"
          className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <TrashIcon className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => store.getState().patch(tabId, { debugOpen: false })}
          aria-label="Hide"
          title="Hide (D)"
          className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronDownIcon className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[11px]">
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
            <div className="sticky top-0 flex h-6 items-center gap-2 border-b border-border bg-card px-2.5 font-sans text-[10.5px] text-muted-foreground">
              <span className="w-10 shrink-0">Method</span>
              <span className="min-w-0 flex-1">Address</span>
              <span className="w-10 shrink-0 text-right">Status</span>
              <span className="w-12 shrink-0">Type</span>
              <span className="w-12 shrink-0 text-right">Time</span>
              <span className="w-[6.5rem] shrink-0" />
            </div>
            {tab.network.map((entry) => (
              <NetworkRow
                key={entry.id}
                entry={entry}
                onFix={() => sendToChat(requestPayload({ page: pageUrl, entry }), "Fix this request.")}
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
        active ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Count({ tone, children }: { tone: "error" | "warn"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums",
        tone === "error"
          ? "bg-destructive/12 text-destructive"
          : "bg-amber-500/15 text-amber-700 dark:text-amber-400",
      )}
    >
      {children}
    </span>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-3 py-4 font-sans text-xs text-muted-foreground">{text}</div>;
}

function FixButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded border border-border bg-background px-1.5 font-sans text-[10.5px] font-medium text-foreground opacity-80 hover:bg-accent hover:opacity-100 group-hover:opacity-100"
    >
      <WrenchIcon className="size-2.5" />
      Ask agent to fix
    </button>
  );
}

function ConsoleRow({ entry, onFix }: { entry: ConsoleEntry; onFix: () => void }) {
  const [open, setOpen] = useState(false);
  const problem = entry.level === "error" || entry.level === "warn";
  const Icon =
    entry.level === "error" ? CircleAlertIcon : entry.level === "warn" ? TriangleAlertIcon : InfoIcon;
  const hasMore = Boolean(entry.stack);
  return (
    <div
      className={cn(
        "group border-b border-border/60",
        entry.level === "error" && "bg-destructive/[0.06] text-destructive",
        entry.level === "warn" && "bg-amber-500/[0.08] text-amber-800 dark:text-amber-300",
        !problem && "text-foreground/85",
      )}
      data-level={entry.level}
    >
      <div
        className={cn("flex min-h-6 items-start gap-1.5 px-2 py-1", hasMore && "cursor-pointer")}
        onClick={() => hasMore && setOpen((value) => !value)}
      >
        {hasMore ? (
          open ? (
            <ChevronDownIcon className="mt-0.5 size-3 shrink-0 opacity-60" />
          ) : (
            <ChevronRightIcon className="mt-0.5 size-3 shrink-0 opacity-60" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <Icon className="mt-0.5 size-3 shrink-0" />
        <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{entry.message}</span>
        {entry.source ? (
          <span className="shrink-0 text-[10.5px] text-muted-foreground underline-offset-2">
            {entry.source}
          </span>
        ) : null}
        {problem ? <FixButton onClick={onFix} /> : null}
      </div>
      {open && entry.stack ? (
        <pre className="overflow-x-auto px-9 pb-1.5 text-[10.5px] leading-relaxed whitespace-pre opacity-80">
          {entry.stack}
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
        "group border-b border-border/60",
        failed ? "bg-destructive/[0.06] text-destructive" : "text-foreground/85",
      )}
    >
      <div
        className={cn("flex h-6 items-center gap-2 px-2.5", hasMore && "cursor-pointer")}
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
        <span className="flex w-[6.5rem] shrink-0 justify-end">
          {failed ? <FixButton onClick={onFix} /> : null}
        </span>
      </div>
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
