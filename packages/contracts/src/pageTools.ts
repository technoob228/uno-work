/**
 * Comment and Debug in the desktop app's panel browser (w0139): the wire
 * between the page's preload (apps/desktop/src/pagePreload.ts — runs in the
 * page's own isolated world before any of its scripts, like upstream t3's
 * PickPreload), the desktop main process (console and network from the
 * page's DevTools protocol, inside the app — never a debugging port) and the
 * app (apps/web …/preview/annotate/usePageTools.ts).
 *
 *   page preload  ──sendToHost(PAGE_TOOLS_HOST_CHANNEL, message)──▶  <webview> `ipc-message`
 *   <webview>.send(PAGE_TOOLS_COMMAND_CHANNEL, command)  ──▶  page preload
 *   page preload  ──send(PAGE_TOOLS_DEBUG_CHANNEL, on)──▶  main: capture this page's console/network
 *   main  ──send(PAGE_TOOLS_RELAY_CHANNEL, message)──▶  page preload  ──▶  host (one ordered stream)
 *
 * The messages are the same objects the in-page script (pageToolsScript.ts:
 * the demo's iframe and desktop shells without the preload) reports.
 *
 * No imports: the page preload bundles this file alone.
 */

/** Bump when the wire changes; the app checks `desktopBridge.pageTools.version`. */
export const PAGE_TOOLS_PRELOAD_VERSION = 1;

export const PAGE_TOOLS_HOST_CHANNEL = "uno-page-tools";
export const PAGE_TOOLS_COMMAND_CHANNEL = "uno-page-tools:command";
export const PAGE_TOOLS_DEBUG_CHANNEL = "uno-page-tools:debug";
export const PAGE_TOOLS_RELAY_CHANNEL = "uno-page-tools:relay";

/** Partitions of the panel browser's <webview>s (web browserUrl.ts): they get the preload. */
export const PAGE_TOOLS_PARTITION_PREFIX = "persist:uno-browser";

export type PageToolsWireConsoleLevel = "error" | "warn" | "info" | "log";

export interface PageToolsWireConsoleEntry {
  readonly id: string;
  readonly level: PageToolsWireConsoleLevel;
  readonly message: string;
  readonly stack: string | null;
  readonly source: string | null;
  readonly at: number;
}

export interface PageToolsWireNetworkEntry {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly status: number | null;
  readonly statusText: string;
  readonly type: "fetch" | "xhr" | "img" | "script" | "css" | "other";
  readonly durationMs: number | null;
  readonly requestBody: string | null;
  readonly responseBody: string | null;
  readonly at: number;
}

export interface PageToolsWireRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface PageToolsWirePick {
  readonly kind: "element" | "area";
  readonly selector: string | null;
  readonly label: string;
  readonly text: string | null;
  readonly rect: PageToolsWireRect;
  readonly docRect: PageToolsWireRect;
}

export interface PageToolsWirePin {
  readonly n: number;
  readonly kind: "element" | "area";
  readonly selector: string | null;
  readonly docRect: PageToolsWireRect;
}

/** What the person selected on the page, for a quote; empty text — nothing any more. */
export interface PageToolsWireSelection {
  readonly text: string;
  readonly url: string;
  /** The selection's last line, in the page's viewport (CSS pixels). */
  readonly rect: PageToolsWireRect;
}

export type PageToolsWireMessage =
  | { readonly type: "ready"; readonly data: { readonly url: string; readonly title: string } }
  | { readonly type: "console"; readonly data: PageToolsWireConsoleEntry }
  | { readonly type: "network"; readonly data: PageToolsWireNetworkEntry }
  | { readonly type: "pick"; readonly data: PageToolsWirePick }
  | { readonly type: "pinClick"; readonly data: { readonly n: number } }
  | { readonly type: "selection"; readonly data: PageToolsWireSelection }
  | { readonly type: "key"; readonly data: { readonly key: string } };

/** What the app tells the page (the same three calls the in-page script takes). */
export type PageToolsWireCommand =
  | { readonly method: "setMode"; readonly arg: "comment" | "off" }
  | { readonly method: "setPins"; readonly arg: ReadonlyArray<PageToolsWirePin> }
  | { readonly method: "setPaused"; readonly arg: boolean };
