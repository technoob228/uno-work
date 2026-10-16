/**
 * A page of the computer's own browser (the agent's, shown live in the panel
 * as a picture) that talks like the desktop app's <webview> to Comment and
 * Debug (usePageTools) — the third adapter after the real <webview> and the
 * demo's iframe (iframeWebview.ts).
 *
 *   - `executeJavaScript` → `browserLive.evaluate` (the page's main world, a
 *     JSON answer);
 *   - the page script runs with the queue channel (pageToolsScript.ts): this
 *     view drains the queue (fast while Comment is on, slowly otherwise) and
 *     hands each line on as `console-message`, the way a <webview> does;
 *   - no script in the document any more (the page went somewhere else) →
 *     `dom-ready`, and usePageTools puts it in again;
 *   - `pointer(...)` — the person's pointer over the picture, in the page's
 *     CSS pixels: the script highlights and picks; the page's own events (the
 *     agent's clicks) are never touched.
 */
import type {
  BrowserLiveCaptureInput,
  BrowserLiveCaptureResult,
  BrowserLiveEvaluateInput,
  BrowserLiveEvaluateResult,
} from "@t3tools/contracts";

import {
  PAGE_TOOLS_DRAIN_EXPRESSION,
  type PagePick,
  pageToolsPointerCall,
  type PageToolsPointerMethod,
} from "./pageToolsScript";
import type { PageToolsView } from "./usePageTools";

/** While Comment is on: the page's picks and highlights should feel immediate. */
export const LIVE_POLL_FAST_MS = 150;
/** Otherwise: the error count on the button, without busying the page. */
export const LIVE_POLL_SLOW_MS = 2_000;
/** A missing script is put in again at most this often (a page that keeps loading). */
const REINSTALL_MIN_MS = 1_000;

export interface LivePageApi {
  evaluate(input: BrowserLiveEvaluateInput): Promise<BrowserLiveEvaluateResult>;
  capture(input: BrowserLiveCaptureInput): Promise<BrowserLiveCaptureResult>;
}

/**
 * What a drain returned: the queued lines, or `null` — the script is not in
 * this document (put it in again). Anything else (an error page's odd value)
 * is "nothing new".
 */
export function parseDrained(json: string | null): ReadonlyArray<string> | null {
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (value === null) return null;
  if (!Array.isArray(value)) return [];
  return value.filter((line): line is string => typeof line === "string");
}

export function base64ToBlob(data: string, type: string): Blob {
  const bytes = atob(data);
  const buffer = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) buffer[index] = bytes.charCodeAt(index);
  return new Blob([buffer], { type });
}

export class LivePageView extends EventTarget implements PageToolsView {
  readonly pageToolsChannel = "queue" as const;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private fast = false;
  private disposed = false;
  private lastReinstallAt = 0;
  /** The pointer's last hover/drag waiting for the one in flight (only the newest matters). */
  private pendingMove: { method: PageToolsPointerMethod; coords: number[] } | null = null;
  private moveInFlight = false;

  constructor(
    private readonly api: LivePageApi,
    readonly pageId: string,
  ) {
    super();
    this.schedule(0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Comment on: drain often; off: now and then. */
  setFast(fast: boolean): void {
    if (this.fast === fast) return;
    this.fast = fast;
    if (fast) this.schedule(0);
  }

  executeJavaScript(code: string): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("The page view is closed."));
    return this.api
      .evaluate({ pageId: this.pageId, expression: code })
      .then((result) => (result?.json == null ? undefined : (JSON.parse(result.json) as unknown)));
  }

  /**
   * The person's pointer over the picture. Moves (hover, an area being
   * dragged) keep only the newest while one is on its way; picks always go.
   */
  pointer(method: PageToolsPointerMethod, coords: number[]): void {
    if (this.disposed) return;
    if (method === "hoverAt" || method === "dragAt") {
      if (this.moveInFlight) {
        this.pendingMove = { method, coords };
        return;
      }
      this.moveInFlight = true;
      void this.executeJavaScript(pageToolsPointerCall(method, coords))
        .catch(() => undefined)
        .finally(() => {
          this.moveInFlight = false;
          const next = this.pendingMove;
          this.pendingMove = null;
          if (next) this.pointer(next.method, next.coords);
        });
      return;
    }
    this.pendingMove = null;
    void this.executeJavaScript(pageToolsPointerCall(method, coords))
      .catch(() => undefined)
      // A pick answers in the queue: read it now, not at the next tick.
      .finally(() => this.schedule(0));
  }

  /** Scroll the page under the picture (Comment on, the agent still drives). */
  scrollBy(deltaX: number, deltaY: number): void {
    const dx = Number.isFinite(deltaX) ? Math.round(deltaX) : 0;
    const dy = Number.isFinite(deltaY) ? Math.round(deltaY) : 0;
    void this.executeJavaScript(`window.scrollBy(${dx}, ${dy}); true`).catch(() => undefined);
  }

  /** A PNG of part of the page, for a comment. */
  capture(rect: PagePick["rect"]): Promise<Blob | null> {
    return this.api
      .capture({ pageId: this.pageId, x: rect.x, y: rect.y, width: rect.w, height: rect.h })
      .then((result) => (result?.data ? base64ToBlob(result.data, "image/png") : null))
      .catch(() => null);
  }

  private schedule(delay: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delay);
  }

  private async poll(): Promise<void> {
    if (this.disposed) return;
    if (this.polling) {
      this.schedule(this.fast ? LIVE_POLL_FAST_MS : LIVE_POLL_SLOW_MS);
      return;
    }
    this.polling = true;
    try {
      const result = await this.api.evaluate({
        pageId: this.pageId,
        expression: PAGE_TOOLS_DRAIN_EXPRESSION,
      });
      if (this.disposed) return;
      const lines = parseDrained(result?.json ?? "[]");
      if (lines === null) {
        const now = Date.now();
        if (now - this.lastReinstallAt >= REINSTALL_MIN_MS) {
          this.lastReinstallAt = now;
          this.dispatchEvent(new Event("dom-ready"));
        }
      } else {
        for (const message of lines) {
          this.dispatchEvent(
            Object.assign(new Event("console-message", { cancelable: true }), {
              message,
              level: "debug",
            }),
          );
        }
      }
    } catch {
      // The page is loading, closed, or the computer is away: try again later.
    } finally {
      this.polling = false;
      this.schedule(this.fast ? LIVE_POLL_FAST_MS : LIVE_POLL_SLOW_MS);
    }
  }
}
