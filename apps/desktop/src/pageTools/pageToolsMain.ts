/**
 * Comment and Debug for the panel browser, main-process half (w0139):
 *
 *   - the panel browser's <webview>s (partition `persist:uno-browser*`) get
 *     the page preload (pagePreload.ts) — and only they: app widgets and
 *     other guests stay preload-free, as before;
 *   - each such page's console and network come from its own DevTools
 *     protocol through `webContents.debugger`, inside the app (no
 *     `remote-debugging-port`: 9222 is taken by the person's Chrome, 9223 is
 *     the app's dev port), translated by pageDebugCdp.ts and handed to the
 *     page's preload (pageToolsRelay.ts decides when), which passes them to
 *     the app in one ordered stream with its own Comment messages;
 *   - if the protocol can't be had (the page's DevTools hold it), the
 *     guest's own `console-message` / `did-fail-load` events stand in.
 *
 * The page itself never sees any of this: the preload lives in its isolated
 * world, the protocol in this process.
 */
import type { IpcMain, IpcMainEvent, Session, WebContents, WebPreferences } from "electron";

import {
  PAGE_TOOLS_DEBUG_CHANNEL,
  PAGE_TOOLS_PARTITION_PREFIX,
  PAGE_TOOLS_RELAY_CHANNEL,
  type PageToolsWireMessage,
} from "@t3tools/contracts/pageTools";

import { consoleMessageFallback, PageDebugTranslator } from "./pageDebugCdp.ts";
import { PageToolsRelay } from "./pageToolsRelay.ts";

const CDP_VERSION = "1.3";

interface GuestState {
  readonly contents: WebContents;
  readonly relay: PageToolsRelay<PageToolsWireMessage>;
  readonly translator: PageDebugTranslator;
  fallback: boolean;
  fallbackSeq: number;
}

/** The <webview>'s own first address, loaded by us once Debug listens. */
interface FirstLoad {
  readonly src: string;
  readonly httpReferrer: string | undefined;
  readonly userAgent: string | undefined;
}

export interface PageToolsMainDeps {
  readonly ipcMain: IpcMain;
  /** Absolute path of the built page preload (dist-electron/pagePreload.cjs). */
  readonly preloadPath: string;
  readonly sessionFromPartition: (partition: string) => Session;
  readonly log: {
    readonly info: (message: string, details?: Record<string, unknown>) => void;
    readonly warn: (message: string, details?: Record<string, unknown>) => void;
  };
}

/** The panel browser's partitions — not app widgets (`persist:uno-apps`) or anything else. */
export function isPageToolsPartition(partition: unknown): partition is string {
  return (
    typeof partition === "string" &&
    (partition === PAGE_TOOLS_PARTITION_PREFIX ||
      partition.startsWith(`${PAGE_TOOLS_PARTITION_PREFIX}-`))
  );
}

export function createPageToolsMain(deps: PageToolsMainDeps) {
  const previewSessions = new WeakSet<Session>();
  // will-attach → did-attach of the same partition come in order.
  const firstLoads = new WeakMap<Session, Array<FirstLoad | null>>();
  const guests = new Map<number, GuestState>();

  const send = (state: GuestState, messages: ReadonlyArray<PageToolsWireMessage>) => {
    if (messages.length === 0 || state.contents.isDestroyed()) return;
    for (const message of messages) {
      try {
        state.contents.send(PAGE_TOOLS_RELAY_CHANNEL, message);
      } catch {
        // The page is going away; the next page starts clean.
      }
    }
  };
  const deliver = (state: GuestState, message: PageToolsWireMessage) =>
    send(state, state.relay.push(message));

  const installFallback = (state: GuestState) => {
    if (state.fallback || state.contents.isDestroyed()) return;
    state.fallback = true;
    const contents = state.contents;
    contents.on("console-message", (...args: unknown[]) => {
      if (!state.fallback) return;
      // Electron 41: one event object; older: (event, level, message, line, sourceId).
      const event = args[0] as {
        level?: string | number;
        message?: string;
        lineNumber?: number;
        sourceId?: string;
      };
      const input =
        typeof event?.message === "string"
          ? {
              level: event.level ?? "info",
              message: event.message,
              ...(event.sourceId ? { sourceId: event.sourceId } : {}),
              ...(event.lineNumber ? { lineNumber: event.lineNumber } : {}),
            }
          : {
              level: args[1] as number,
              message: String(args[2] ?? ""),
              lineNumber: Number(args[3] ?? 0),
              sourceId: String(args[4] ?? ""),
            };
      state.fallbackSeq += 1;
      const message = consoleMessageFallback(input, `f${state.fallbackSeq}`, Date.now());
      if (message) deliver(state, message);
    });
    contents.on(
      "did-fail-load",
      (_event, errorCode: number, errorDescription: string, validatedURL: string) => {
        if (!state.fallback || errorCode === -3) return; // -3: aborted (navigated away)
        state.fallbackSeq += 1;
        deliver(state, {
          type: "network",
          data: {
            id: `f${state.fallbackSeq}`,
            method: "GET",
            url: validatedURL,
            status: null,
            statusText: errorDescription || `Error ${errorCode}`,
            type: "other",
            durationMs: null,
            requestBody: null,
            responseBody: null,
            at: Date.now(),
          },
        });
      },
    );
  };

  /** Resolves once the page's console and network are being listened to (or can't be). */
  const attachDebugger = (state: GuestState): Promise<void> => {
    const contents = state.contents;
    const debuggerApi = contents.debugger;
    try {
      if (!debuggerApi.isAttached()) debuggerApi.attach(CDP_VERSION);
    } catch (error) {
      deps.log.warn("[page-tools] DevTools protocol unavailable, using page events", {
        error: error instanceof Error ? error.message : String(error),
      });
      installFallback(state);
      return Promise.resolve();
    }
    debuggerApi.on("message", (_event, method: string, params: unknown) => {
      const out = state.translator.handle(method, params);
      for (const message of out.messages) deliver(state, message);
      const bodyFor = out.bodyFor;
      if (bodyFor) {
        void debuggerApi
          .sendCommand("Network.getResponseBody", { requestId: bodyFor.requestId })
          .then((result: { body?: string; base64Encoded?: boolean }) =>
            result?.base64Encoded || typeof result?.body !== "string" ? null : result.body,
          )
          .catch(() => null)
          .then((body) => deliver(state, bodyFor.withBody(body)));
      }
    });
    debuggerApi.on("detach", (_event, reason: string) => {
      if (contents.isDestroyed() || reason === "target closed") return;
      deps.log.info("[page-tools] DevTools protocol detached, using page events", { reason });
      installFallback(state);
    });
    return Promise.all([
      debuggerApi.sendCommand("Runtime.enable"),
      debuggerApi.sendCommand("Log.enable"),
      debuggerApi.sendCommand("Network.enable", {
        maxTotalBufferSize: 10 * 1024 * 1024,
        maxResourceBufferSize: 1024 * 1024,
        maxPostDataSize: 4096,
      }),
    ])
      .then(() => undefined)
      .catch((error: unknown) => {
        deps.log.warn("[page-tools] enabling DevTools domains failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        installFallback(state);
      });
  };

  const track = (contents: WebContents, firstLoad: FirstLoad | null) => {
    if (guests.has(contents.id)) return;
    const state: GuestState = {
      contents,
      relay: new PageToolsRelay<PageToolsWireMessage>(),
      translator: new PageDebugTranslator(),
      fallback: false,
      fallbackSeq: 0,
    };
    guests.set(contents.id, state);
    const id = contents.id;
    contents.once("destroyed", () => guests.delete(id));
    // A new document committed in the tab: its preload will say hello.
    contents.on("did-navigate", () => state.relay.navigationStarted());
    // The first page loads once the network is listened to, so its own
    // request and everything it pulls in are in Debug too.
    void attachDebugger(state).then(() => {
      if (!firstLoad || contents.isDestroyed()) return;
      void contents
        .loadURL(firstLoad.src, {
          ...(firstLoad.httpReferrer ? { httpReferrer: firstLoad.httpReferrer } : {}),
          ...(firstLoad.userAgent ? { userAgent: firstLoad.userAgent } : {}),
        })
        .catch(() => {
          // A failed or replaced first load shows in the tab like any other.
        });
    });
  };

  const onDebugMessage = (event: IpcMainEvent, kind: unknown) => {
    const state = guests.get(event.sender.id);
    // Only the panel browser's own pages, only their top frame.
    if (!state || state.contents !== event.sender) return;
    if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) return;
    if (kind === "hello") send(state, state.relay.hello());
    else if (kind === "enable") send(state, state.relay.enable());
  };
  deps.ipcMain.on(PAGE_TOOLS_DEBUG_CHANNEL, onDebugMessage);

  return {
    /**
     * From `will-attach-webview`, after the address was checked: the panel
     * browser gets the page preload, and its first address waits for Debug
     * (didAttachWebview loads it).
     */
    willAttachWebview(webPreferences: WebPreferences, params: Record<string, string>): void {
      const partition =
        params.partition ?? (webPreferences as WebPreferences & { partition?: string }).partition;
      if (!isPageToolsPartition(partition)) return;
      webPreferences.preload = deps.preloadPath;
      const guestSession = deps.sessionFromPartition(partition);
      previewSessions.add(guestSession);
      const src = params.src?.trim();
      const queue = firstLoads.get(guestSession) ?? [];
      queue.push(
        src ? { src, httpReferrer: params.httpreferrer, userAgent: params.useragent } : null,
      );
      firstLoads.set(guestSession, queue);
      if (src) params.src = "";
    },
    /** From `did-attach-webview`: console and network for the panel browser's pages. */
    didAttachWebview(contents: WebContents): void {
      if (!previewSessions.has(contents.session)) return;
      const firstLoad = firstLoads.get(contents.session)?.shift() ?? null;
      track(contents, firstLoad);
    },
    dispose(): void {
      deps.ipcMain.removeListener(PAGE_TOOLS_DEBUG_CHANNEL, onDebugMessage);
      for (const state of guests.values()) {
        try {
          if (!state.contents.isDestroyed() && state.contents.debugger.isAttached()) {
            state.contents.debugger.detach();
          }
        } catch {
          // gone
        }
      }
      guests.clear();
    },
  };
}
