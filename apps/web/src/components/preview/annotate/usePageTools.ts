/**
 * Wires one browser tab's page to Comment and Debug (w0138): puts the page
 * script in on every new document, reads what it reports (console, network,
 * picks, keys) into the tab's state, and keeps the page's mode and pins in
 * step with that state. Works with anything that talks like Electron's
 * <webview>: the desktop app's own, or the demo's iframe (iframeWebview.ts).
 *
 * Desktop 0.0.139+ (w0139): the desktop's page preload already lives in every
 * page of the panel browser (before the page's scripts, in its isolated
 * world; console and network from the page's DevTools protocol in the app's
 * main process) — then nothing is put into the page: the same messages come
 * as the <webview>'s `ipc-message`, the calls go as `<webview>.send`
 * (contracts pageTools.ts). Older desktop apps and the demo: the script.
 *
 * "Your site" in the web's iframe (another origin, postMessageWebview.ts):
 * the daemon already put the script in the page; it gets its nonce and the
 * tab's state as messages (`postPageTools`), its lines come back as
 * `console-message` like the console channel's.
 */
import {
  PAGE_TOOLS_COMMAND_CHANNEL,
  PAGE_TOOLS_HOST_CHANNEL,
  PAGE_TOOLS_PRELOAD_VERSION,
  type PageToolsWireCommand,
} from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import type { ConsoleEntry, NetworkEntry } from "./pageTools.logic";
import {
  buildPageToolsScript,
  type PagePick,
  type PagePin,
  type PageToolsChannel,
  pageToolsCall,
  type PageToolsPostCommand,
  type PageToolsMessage,
  pageSelectionFrom,
  parsePageToolsMessage,
} from "./pageToolsScript";
import { usePageToolsStore } from "./pageToolsStore";

/** The part of a <webview> this needs. */
export interface PageToolsView {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  /** A real <webview>: a message to its page's preload. */
  send?(channel: string, ...args: unknown[]): void;
  /** How the page script talks back (the computer's live browser: a queue the view drains). */
  readonly pageToolsChannel?: PageToolsChannel;
  /** The postMessage channel: a call into the script the page already has. */
  postPageTools?(command: PageToolsPostCommand): void;
}

/** A picture of part of the page (viewport CSS pixels) for a comment; null — none. */
export type PageToolsCapture = (rect: PagePick["rect"]) => Promise<Blob | null>;

/** Room around the picked element in its picture, so the agent sees where it is. */
export const COMMENT_SHOT_PADDING = 16;

/** The part of the viewport a comment's picture takes: the pick plus some room. */
export function commentShotRect(rect: PagePick["rect"]): PagePick["rect"] {
  return {
    x: Math.max(0, rect.x - COMMENT_SHOT_PADDING),
    y: Math.max(0, rect.y - COMMENT_SHOT_PADDING),
    w: rect.w + COMMENT_SHOT_PADDING * 2 + Math.min(0, rect.x - COMMENT_SHOT_PADDING),
    h: rect.h + COMMENT_SHOT_PADDING * 2 + Math.min(0, rect.y - COMMENT_SHOT_PADDING),
  };
}

/** The desktop's page preload serves this view (desktop 0.0.139+, a real <webview>). */
export function pageToolsPreloadServes(
  view: PageToolsView,
  bridge: { readonly pageTools?: { readonly version: number } } | undefined,
): boolean {
  return (
    typeof view.send === "function" &&
    (bridge?.pageTools?.version ?? 0) >= PAGE_TOOLS_PRELOAD_VERSION
  );
}

export function usePageTools(input: {
  readonly tabId: string;
  readonly view: PageToolsView | null;
  /** Off for pages the tools can't reach (the web build's companion tab). */
  readonly enabled: boolean;
  /** A picture of the picked element goes with the comment (desktop, the computer's browser). */
  readonly capture?: PageToolsCapture;
}): void {
  const { tabId, view, enabled } = input;
  const readyRef = useRef(false);
  const captureRef = useRef(input.capture);
  captureRef.current = input.capture;

  // The script in, and the page's reports out.
  useEffect(() => {
    if (!view || !enabled) return;
    const nonce = `uno-page-tools:${crypto.randomUUID()}:`;
    const store = usePageToolsStore.getState;
    const viaPreload = pageToolsPreloadServes(
      view,
      typeof window === "undefined" ? undefined : window.desktopBridge,
    );
    const viaPostMessage =
      view.pageToolsChannel === "postMessage" && typeof view.postPageTools === "function";
    readyRef.current = false;

    const syncPage = () => {
      const tab = store().tabs[tabId];
      const pins: PagePin[] = (tab?.comments ?? []).map((comment) => ({
        n: comment.n,
        kind: comment.kind,
        selector: comment.selector,
        docRect: comment.docRect,
      }));
      if (viaPostMessage) {
        view.postPageTools?.({ method: "setMode", arg: tab?.commenting ? "comment" : "off" });
        view.postPageTools?.({ method: "setPins", arg: pins });
        view.postPageTools?.({ method: "setPaused", arg: tab?.draft != null });
        return;
      }
      if (viaPreload) {
        const commands: PageToolsWireCommand[] = [
          { method: "setMode", arg: tab?.commenting ? "comment" : "off" },
          { method: "setPins", arg: pins },
          { method: "setPaused", arg: tab?.draft != null },
        ];
        try {
          for (const command of commands) view.send?.(PAGE_TOOLS_COMMAND_CHANNEL, command);
        } catch {
          // the page isn't attached yet: dom-ready syncs it
        }
        return;
      }
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
      if (viaPostMessage) {
        // The script is in the page already (the daemon put it there).
        view.postPageTools?.({ method: "setNonce", arg: nonce });
        readyRef.current = true;
        syncPage();
        return;
      }
      if (viaPreload) {
        // The preload is already in the page: just tell it the tab's state.
        readyRef.current = true;
        syncPage();
        return;
      }
      void view
        .executeJavaScript(buildPageToolsScript(nonce, view.pageToolsChannel ?? "console"), false)
        .then(() => {
          readyRef.current = true;
          syncPage();
        })
        .catch(() => {});
    };
    const handle = (message: PageToolsMessage) => {
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
        case "pick": {
          const pick = message.data;
          actions.patch(tabId, { draft: { kind: "new", pick } });
          const capture = captureRef.current;
          if (capture && pick.rect.w > 0 && pick.rect.h > 0) {
            void capture(commentShotRect(pick.rect))
              .then((shot) => {
                if (shot) store().setShot(tabId, pick, shot);
              })
              .catch(() => {});
          }
          return;
        }
        case "pinClick": {
          const comment = store().tabs[tabId]?.comments.find((c) => c.n === message.data.n);
          if (comment) actions.patch(tabId, { draft: { kind: "edit", commentId: comment.id } });
          return;
        }
        case "selection":
          actions.patch(tabId, { selection: pageSelectionFrom(message.data) });
          return;
        case "key": {
          if (message.data.key === "c") actions.toggleMode(tabId);
          else if (message.data.key === "Escape") actions.escape(tabId);
          return;
        }
      }
    };
    const onConsoleMessage = (event: Event) => {
      const message = parsePageToolsMessage(
        nonce,
        (event as Event & { message?: unknown }).message,
      );
      if (!message) return;
      // Ours: not the page's own console line.
      event.preventDefault();
      handle(message);
    };
    const onIpcMessage = (event: Event) => {
      const { channel, args } = event as Event & { channel?: unknown; args?: unknown };
      if (channel !== PAGE_TOOLS_HOST_CHANNEL || !Array.isArray(args)) return;
      const message = args[0] as PageToolsMessage | undefined;
      if (message && typeof message === "object" && typeof message.type === "string") {
        handle(message);
      }
    };
    view.addEventListener("dom-ready", install);
    if (viaPreload) view.addEventListener("ipc-message", onIpcMessage);
    else view.addEventListener("console-message", onConsoleMessage);
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
      view.removeEventListener("ipc-message", onIpcMessage);
      view.removeEventListener("console-message", onConsoleMessage);
      unsubscribe();
    };
  }, [view, enabled, tabId]);
}
