/**
 * Wires one browser tab's page to Comment and Debug (w0138): puts the page
 * script in on every new document, reads what it reports (console, network,
 * picks, keys) into the tab's state, and keeps the page's mode and pins in
 * step with that state. Works with anything that talks like Electron's
 * <webview>: the desktop app's own, or the demo's iframe (iframeWebview.ts).
 */
import { useEffect, useRef } from "react";

import type { ConsoleEntry, NetworkEntry } from "./pageTools.logic";
import {
  buildPageToolsScript,
  type PagePin,
  pageToolsCall,
  parsePageToolsMessage,
} from "./pageToolsScript";
import { usePageToolsStore } from "./pageToolsStore";

/** The part of a <webview> this needs. */
export interface PageToolsView {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export function usePageTools(input: {
  readonly tabId: string;
  readonly view: PageToolsView | null;
  /** Off for pages the tools can't reach (the web build's companion tab). */
  readonly enabled: boolean;
}): void {
  const { tabId, view, enabled } = input;
  const readyRef = useRef(false);

  // The script in, and the page's reports out.
  useEffect(() => {
    if (!view || !enabled) return;
    const nonce = `uno-page-tools:${crypto.randomUUID()}:`;
    const store = usePageToolsStore.getState;
    readyRef.current = false;

    const syncPage = () => {
      const tab = store().tabs[tabId];
      const pins: PagePin[] = (tab?.comments ?? []).map((comment) => ({
        n: comment.n,
        kind: comment.kind,
        selector: comment.selector,
        docRect: comment.docRect,
      }));
      void view
        .executeJavaScript(
          [
            pageToolsCall("setMode", tab?.commenting ? "comment" : "off"),
            pageToolsCall("setPins", pins),
            pageToolsCall("setPaused", tab?.draft != null),
          ].join(";"),
          false,
        )
        .catch(() => {});
    };
    const install = () => {
      void view
        .executeJavaScript(buildPageToolsScript(nonce), false)
        .then(() => {
          readyRef.current = true;
          syncPage();
        })
        .catch(() => {});
    };
    const onConsoleMessage = (event: Event) => {
      const message = parsePageToolsMessage(
        nonce,
        (event as Event & { message?: unknown }).message,
      );
      if (!message) return;
      // Ours: not the page's own console line.
      event.preventDefault();
      const actions = store();
      switch (message.type) {
        case "ready":
          actions.resetLogs(tabId);
          return;
        case "console":
          actions.addConsole(tabId, message.data as ConsoleEntry);
          return;
        case "network":
          actions.addNetwork(tabId, message.data as NetworkEntry);
          return;
        case "pick":
          actions.patch(tabId, { draft: { kind: "new", pick: message.data } });
          return;
        case "pinClick": {
          const comment = store().tabs[tabId]?.comments.find((c) => c.n === message.data.n);
          if (comment) actions.patch(tabId, { draft: { kind: "edit", commentId: comment.id } });
          return;
        }
        case "key": {
          const tab = store().tabs[tabId];
          if (message.data.key === "c") actions.toggleCommenting(tabId);
          else if (message.data.key === "d") actions.toggleDebug(tabId);
          else if (message.data.key === "Escape") {
            if (tab?.draft) actions.patch(tabId, { draft: null });
            else if (tab?.commenting) actions.patch(tabId, { commenting: false });
          }
          return;
        }
      }
    };
    view.addEventListener("dom-ready", install);
    view.addEventListener("console-message", onConsoleMessage);
    // A page that was already up when the tools came.
    install();
    const unsubscribe = usePageToolsStore.subscribe((next, previous) => {
      const a = next.tabs[tabId];
      const b = previous.tabs[tabId];
      if (
        readyRef.current &&
        (a?.commenting !== b?.commenting || a?.comments !== b?.comments || a?.draft !== b?.draft)
      ) {
        syncPage();
      }
    });
    return () => {
      view.removeEventListener("dom-ready", install);
      view.removeEventListener("console-message", onConsoleMessage);
      unsubscribe();
    };
  }, [view, enabled, tabId]);
}
