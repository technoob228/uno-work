/**
 * A browser tab of the panel in the web version (p.14, see
 * yourBrowserTab.logic.ts): its own page in the computer's browser, shown
 * live (LiveBrowserView `mine`). The page is asked for when the tab is first
 * on screen, kept while the tab lives (switching tabs only stops the
 * picture), and closed on the computer when the tab is closed. After a reload
 * a restored tab gets a fresh page at its address (sign-ins stay in the
 * profile); the old load's pages are closed (see yourBrowserSession).
 */
import { BROWSER_LIVE_SETUP_PAGE_ID, type EnvironmentId } from "@t3tools/contracts";
import { MonitorIcon, RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  liveBrowserTabId,
  liveBrowserTabName,
  readBrowserLiveState,
  useBrowserLiveState,
} from "./browserLiveStore";
import { CompanionExtensionDetails, useCompanionExtensionCheck } from "./CompanionExtensionPanel";
import { LiveBrowserOpenOutside } from "./LiveBrowserOpenOutside";
import { LiveBrowserView } from "./LiveBrowserView";
import { usePreviewPane, type PreviewFile } from "./PreviewPaneContext";
import {
  findYourBrowserPage,
  isBlankPageUrl,
  isLeftoverPage,
  yourBrowserSession,
  yourBrowserStep,
  yourBrowserTabKey,
} from "./yourBrowserTab.logic";

/** A page that went away is opened again this many times per tab, then the tab says so. */
const MAX_REOPENS = 3;
/**
 * A tab that unmounts and comes back within this time (moved to another
 * level of the panel, React's double effects in dev) keeps its page.
 */
const CLOSE_GRACE_MS = 3_000;

/** Mounted tabs by page key: the page closes only when no view of its tab is left. */
const mountedTabs = new Map<string, number>();

/** Computers whose leftovers of this window's earlier loads are already closed. */
const swept = new Set<EnvironmentId>();

function sweepLeftovers(environmentId: EnvironmentId): void {
  const state = readBrowserLiveState(environmentId);
  if (!state || swept.has(environmentId)) return;
  swept.add(environmentId);
  const api = readEnvironmentApi(environmentId);
  const current = yourBrowserSession();
  for (const page of state.pages) {
    if (!isLeftoverPage(page, current)) continue;
    void api?.browserLive.close({ pageId: page.pageId }).catch(() => undefined);
  }
}

export function YourBrowserTab({
  tab,
  scopeKey,
  environmentId,
  visible,
}: {
  tab: PreviewFile;
  scopeKey: string;
  environmentId: EnvironmentId;
  visible: boolean;
}) {
  const { updateBrowserTab } = usePreviewPane();
  const key = yourBrowserTabKey(yourBrowserSession().sessionKey, tab.id);
  const state = useBrowserLiveState(environmentId);
  const connected = state !== null;
  useEffect(() => {
    if (connected) sweepLeftovers(environmentId);
  }, [connected, environmentId]);
  const page = findYourBrowserPage(state, key);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opensRef = useRef(0);
  const step = yourBrowserStep({ state, page, asking, error });
  const tabUrl = tab.url ?? "";

  const ask = useCallback(() => {
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setError("This computer isn't connected right now.");
      return;
    }
    if (opensRef.current >= MAX_REOPENS + 1) {
      setError("The page keeps closing on the computer.");
      return;
    }
    opensRef.current += 1;
    setAsking(true);
    setError(null);
    void api.browserLive
      .open({ context: {}, url: /^https?:\/\//i.test(tabUrl) ? tabUrl : "", tab: key })
      .catch((cause: unknown) => {
        setAsking(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [environmentId, key, tabUrl]);

  // Only a tab on screen gets a page: tabs restored from the last visit
  // don't start pages on the computer until they're opened.
  useEffect(() => {
    if (visible && step.ask) ask();
  }, [visible, step.ask, ask]);

  const pageId = page?.pageId ?? null;
  useEffect(() => {
    if (pageId) setAsking(false);
  }, [pageId]);

  // The person drives their own page; a page that somehow went to the agent
  // (an older daemon, a restore) comes back once.
  const reclaimedRef = useRef<string | null>(null);
  const control = page?.control ?? null;
  useEffect(() => {
    if (!pageId || control === "human" || reclaimedRef.current === pageId) return;
    reclaimedRef.current = pageId;
    void readEnvironmentApi(environmentId)
      ?.browserLive.setControl({ pageId, control: "human" })
      .catch(() => undefined);
  }, [control, environmentId, pageId]);

  // The panel tab follows its page: name and address (kept for "Open in my
  // browser", for reopening after a restart, and across visits).
  const pageUrl = page?.url ?? null;
  const pageTitle = page?.title ?? null;
  useEffect(() => {
    if (pageUrl === null || pageTitle === null) return;
    const blank = isBlankPageUrl(pageUrl);
    updateBrowserTab(scopeKey, tab.id, {
      ...(blank ? {} : { url: pageUrl }),
      name: blank ? "New tab" : liveBrowserTabName({ url: pageUrl, title: pageTitle }),
    });
  }, [pageTitle, pageUrl, scopeKey, tab.id, updateBrowserTab]);

  // Closing the tab closes its page on the computer.
  useEffect(() => {
    mountedTabs.set(key, (mountedTabs.get(key) ?? 0) + 1);
    return () => {
      const left = (mountedTabs.get(key) ?? 1) - 1;
      if (left > 0) mountedTabs.set(key, left);
      else mountedTabs.delete(key);
      setTimeout(() => {
        if (mountedTabs.has(key)) return;
        const gone = findYourBrowserPage(readBrowserLiveState(environmentId), key);
        if (!gone) return;
        void readEnvironmentApi(environmentId)
          ?.browserLive.close({ pageId: gone.pageId })
          .catch(() => undefined);
      }, CLOSE_GRACE_MS);
    };
  }, [environmentId, key]);

  const outsideUrl = pageUrl && !isBlankPageUrl(pageUrl) ? pageUrl : tabUrl;
  return (
    <div
      className={cn(
        "absolute inset-0 z-10 flex flex-col bg-background",
        !visible && "invisible pointer-events-none",
      )}
      data-testid="your-browser-tab"
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Hidden tabs don't watch their page: the picture stops, the page stays. */}
        {!visible ? null : step.view === "page" && page ? (
          <LiveBrowserView
            mine
            file={{
              id: tab.id,
              name: tab.name,
              kind: "live-browser",
              content: "",
              url: page.url,
              livePageId: page.pageId,
              environmentId,
            }}
          />
        ) : step.view === "setup" ? (
          <LiveBrowserView
            mine
            file={{
              id: liveBrowserTabId(environmentId, BROWSER_LIVE_SETUP_PAGE_ID),
              name: tab.name,
              kind: "live-browser",
              content: "",
              livePageId: BROWSER_LIVE_SETUP_PAGE_ID,
              environmentId,
            }}
          />
        ) : step.view === "error" ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm"
            data-testid="your-browser-error"
          >
            <MonitorIcon className="size-6 text-muted-foreground" />
            <div className="font-medium">The page didn't open on the computer</div>
            <div className="max-w-sm text-xs break-words text-muted-foreground">{error}</div>
            <Button
              size="sm"
              onClick={() => {
                opensRef.current = 0;
                ask();
              }}
            >
              <RotateCwIcon />
              Try again
            </Button>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Spinner className="size-4" />
              {step.view === "connecting"
                ? "Connecting to the computer's browser…"
                : "Opening the page…"}
            </span>
          </div>
        )}
      </div>
      <YourBrowserFooter environmentId={environmentId} url={outsideUrl} />
    </div>
  );
}

/**
 * Under the page: "Open in my browser" as a plain button, and the extension
 * folded into one small line (Misha 16.10 p.14).
 */
function YourBrowserFooter({ environmentId, url }: { environmentId: EnvironmentId; url: string }) {
  const { detectState, check } = useCompanionExtensionCheck();
  const live = /^https?:\/\//i.test(url);
  return (
    <div className="shrink-0 border-t border-border px-3 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          Sign-ins you make here stay on the computer.
        </span>
        {live ? (
          <LiveBrowserOpenOutside environmentId={environmentId} pageUrl={url} labelled />
        ) : (
          <Button size="xs" variant="outline" disabled data-testid="your-browser-open-outside">
            Open in my browser
          </Button>
        )}
      </div>
      <CompanionExtensionDetails
        className="mt-1"
        summaryClassName="text-left text-[11px]"
        summary="Advanced: let the agent use this browser"
        detectState={detectState}
        onCheck={check}
      />
    </div>
  );
}
