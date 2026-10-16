/**
 * A web app only its computer reaches (`localhost:<port>` on a cloud computer):
 * this browser can't open that address, so the app's window shows it in the
 * computer's own browser — the same live picture as the agent's browser, with
 * Take control to click and type (Misha 16.10: "a click opens the app, like on
 * a PC", not "Show on the internet" or "Set up with Uno").
 *
 * One page per app: coming back to the app reuses the page already open on
 * its address. While the computer's browser is still being set up the window
 * says so, and the page shows as soon as it opens.
 */
import { BROWSER_LIVE_SETUP_PAGE_ID, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { liveBrowserTabId, useBrowserLiveState } from "../preview/browserLiveStore";
import { LiveBrowserView } from "../preview/LiveBrowserView";
import type { PreviewFile } from "../preview/PreviewPaneContext";
import { Spinner } from "../ui/spinner";

/** Same app = same origin (scheme, host, port); its own pages may differ. */
export function sameAppOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function ComputerAppPage({
  environmentId,
  url,
  name,
}: {
  environmentId: EnvironmentId;
  url: string;
  name: string;
}) {
  const state = useBrowserLiveState(environmentId);
  const [pageId, setPageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(false);

  // A page of this app already open on the computer (no chat's own page).
  const existing = useMemo(
    () =>
      state?.pages.find((page) => !page.context?.threadId && sameAppOrigin(page.url, url)) ?? null,
    [state, url],
  );

  useEffect(() => {
    if (existing || asked.current || state === null) return;
    asked.current = true;
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setError("This computer isn't connected right now.");
      return;
    }
    void api.browserLive
      .open({ context: {}, url })
      .then((result) => {
        if (result.pageId !== BROWSER_LIVE_SETUP_PAGE_ID) setPageId(result.pageId);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [environmentId, existing, state, url]);

  const page = existing ?? state?.pages.find((candidate) => candidate.pageId === pageId) ?? null;
  const file: PreviewFile | null = page
    ? {
        id: liveBrowserTabId(environmentId, page.pageId),
        name,
        kind: "live-browser",
        content: "",
        url: page.url,
        livePageId: page.pageId,
        environmentId,
      }
    : null;

  if (file) return <LiveBrowserView file={file} />;
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-md text-center text-sm text-muted-foreground">
        {error ? (
          <>
            <div className="text-base font-semibold text-foreground">Couldn't open {name}</div>
            <div className="mt-2">{error}</div>
          </>
        ) : (
          <span className="inline-flex items-center gap-2">
            <Spinner className="size-4" />
            {state?.setup.status && state.setup.status !== "ready"
              ? "Getting the computer's browser ready…"
              : `Opening ${name}…`}
          </span>
        )}
      </div>
    </div>
  );
}
