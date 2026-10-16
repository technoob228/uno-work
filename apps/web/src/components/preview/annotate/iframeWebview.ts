/**
 * An <iframe> that talks like the desktop app's Electron <webview> — the
 * adapter that lets one browser tab (BrowserPane) and one Comment / Debug
 * (pageToolsScript.ts) work with both:
 *
 *   - the desktop app: a real <webview> (its own process, `executeJavaScript`,
 *     `console-message`, `dom-ready`, navigation events);
 *   - the demo of the desktop app in a web page (`useDemoDesktop()`): a
 *     same-origin iframe, so the page's DOM is reachable and the same calls
 *     can be honoured here.
 *
 * Only what the tab uses: load / back / forward / reload / stop, the URL and
 * title, `executeJavaScript`, and the events `did-start-loading`,
 * `did-stop-loading`, `did-navigate`, `did-navigate-in-page`,
 * `page-title-updated`, `dom-ready`, `console-message` (every console call of
 * the page, like Electron's). Back and forward keep their own list and use
 * `location.replace`, so the app's own history (hash routes) is never touched.
 */

type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";
const CONSOLE_LEVELS: ReadonlyArray<ConsoleLevel> = ["log", "info", "warn", "error", "debug"];
const PATCHED = "__unoIframeConsole";

function eventWith(type: string, props: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(type, { cancelable: true }), props);
}

export class IframeWebview extends EventTarget {
  private entries: string[] = [];
  private index = -1;
  private pendingIndex: number | null = null;
  private disposeWindow: (() => void) | null = null;
  private zoom = 1;

  constructor(readonly iframe: HTMLIFrameElement) {
    super();
    iframe.addEventListener("load", this.onLoad);
    // Already loaded before the adapter came (React re-attached the ref).
    if (iframe.contentDocument?.readyState === "complete" && this.readUrl() !== "about:blank") {
      queueMicrotask(() => this.onLoad());
    }
  }

  dispose(): void {
    this.iframe.removeEventListener("load", this.onLoad);
    this.disposeWindow?.();
    this.disposeWindow = null;
  }

  private win(): (Window & typeof globalThis) | null {
    return (this.iframe.contentWindow as (Window & typeof globalThis) | null) ?? null;
  }

  private readUrl(): string {
    try {
      return this.win()?.location.href ?? this.iframe.src;
    } catch {
      return this.iframe.src;
    }
  }

  private emit(type: string, props?: Record<string, unknown>): void {
    this.dispatchEvent(eventWith(type, props));
  }

  private onLoad = (): void => {
    const url = this.readUrl();
    if (!url || url === "about:blank") return;
    if (this.pendingIndex !== null) {
      this.index = this.pendingIndex;
      this.pendingIndex = null;
    } else if (this.entries[this.index] !== url) {
      this.entries = [...this.entries.slice(0, this.index + 1), url];
      this.index = this.entries.length - 1;
    }
    this.watchWindow();
    this.applyZoom();
    this.emit("did-navigate", { url, isMainFrame: true });
    let title = "";
    try {
      title = this.win()?.document.title ?? "";
    } catch {
      // another origin: no title
    }
    if (title) this.emit("page-title-updated", { title });
    this.emit("dom-ready");
    this.emit("did-stop-loading");
  };

  /** Every console call of the page becomes `console-message`, as in Electron. */
  private watchWindow(): void {
    this.disposeWindow?.();
    const win = this.win();
    if (!win) return;
    try {
      const target = win as unknown as Record<string, unknown>;
      if (!target[PATCHED]) {
        target[PATCHED] = true;
        for (const level of CONSOLE_LEVELS) {
          const original = win.console[level].bind(win.console);
          win.console[level] = (...args: unknown[]) => {
            const message = args
              .map((arg) => {
                if (typeof arg === "string") return arg;
                try {
                  return JSON.stringify(arg);
                } catch {
                  return String(arg);
                }
              })
              .join(" ");
            const event = eventWith("console-message", { message, level });
            this.dispatchEvent(event);
            // The host claimed it (our own channels): keep it out of the devtools too.
            if (!event.defaultPrevented) original(...args);
          };
        }
      }
      const onLeave = () => this.emit("did-start-loading");
      const onInPage = () =>
        this.emit("did-navigate-in-page", { url: this.readUrl(), isMainFrame: true });
      win.addEventListener("pagehide", onLeave);
      win.addEventListener("hashchange", onInPage);
      win.addEventListener("popstate", onInPage);
      this.disposeWindow = () => {
        try {
          win.removeEventListener("pagehide", onLeave);
          win.removeEventListener("hashchange", onInPage);
          win.removeEventListener("popstate", onInPage);
        } catch {
          // the window is gone
        }
      };
    } catch {
      // another origin: no console, no events — the tab still shows the page
    }
  }

  // ── The <webview> methods the tab calls ──────────────────────────────

  get src(): string {
    return this.iframe.src;
  }

  loadURL(url: string): Promise<void> {
    this.emit("did-start-loading");
    this.iframe.src = url;
    return Promise.resolve();
  }

  getURL(): string {
    return this.readUrl();
  }

  canGoBack(): boolean {
    return this.index > 0;
  }

  canGoForward(): boolean {
    return this.index < this.entries.length - 1;
  }

  private go(index: number): void {
    const url = this.entries[index];
    if (url === undefined) return;
    this.pendingIndex = index;
    this.emit("did-start-loading");
    try {
      this.win()?.location.replace(url);
    } catch {
      this.iframe.src = url;
    }
  }

  goBack(): void {
    if (this.canGoBack()) this.go(this.index - 1);
  }

  goForward(): void {
    if (this.canGoForward()) this.go(this.index + 1);
  }

  reload(): void {
    this.emit("did-start-loading");
    try {
      this.win()?.location.reload();
    } catch {
      this.iframe.src = this.readUrl();
    }
  }

  /** Like the webview's page zoom (CSS zoom of the page; kept across pages). */
  setZoomFactor(factor: number): void {
    this.zoom = factor;
    this.applyZoom();
  }

  private applyZoom(): void {
    try {
      const root = this.win()?.document.documentElement;
      if (root) root.style.setProperty("zoom", this.zoom === 1 ? "" : String(this.zoom));
    } catch {
      // another origin
    }
  }

  reloadIgnoringCache(): void {
    this.reload();
  }

  stop(): void {
    try {
      this.win()?.stop();
    } catch {
      // nothing to stop
    }
    this.emit("did-stop-loading");
  }

  executeJavaScript(code: string): Promise<unknown> {
    const win = this.win() as (Window & { eval: (code: string) => unknown }) | null;
    // Like a <webview> before dom-ready: the iframe's first blank document
    // is not the page (and its window is reused by the page that comes next).
    if (!win || this.readUrl() === "about:blank" || this.index < 0) {
      return Promise.reject(new Error("The page isn't loaded."));
    }
    try {
      // Indirect eval: runs in the page's global scope, like executeJavaScript.
      return Promise.resolve(win.eval(code));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
