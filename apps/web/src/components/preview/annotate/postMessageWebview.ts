/**
 * The web's iframe for "Your site" from a cloud computer (18.10): the page is
 * on the port's own address (`https://p5173--abc.uno4.work`), another origin
 * than Work, so nothing of it is reachable from here — no `eval`, no
 * console, not even its address. The daemon puts Comment's script into the
 * page (`/__uno/page-tools.js`, channel `postMessage`, pageToolsScript.ts);
 * this adapter is its other end, so the tab and usePageTools treat the frame
 * like the other <webview>s:
 *
 *   - the page's `{ nav }` messages → `did-navigate-in-page` and the title
 *     (the address the tab shows, the history list);
 *   - its `{ line }` messages → `console-message`, as the console channel's;
 *   - the host's calls (`setNonce` first, then setMode / setPins /
 *     setPaused) → `postPageTools`, posted to the port's origin only.
 *
 * Only messages from this frame's window and the port's origin count.
 *
 * The person's own site on Uno Sites (19.10) talks the same way, with one
 * more step: its page answers only a parent whose `setNonce` carries a token
 * the site's server confirms for this Work address (`siteToken`, from the
 * console — siteComment.ts). Calls made while the token comes wait, in order.
 */
import {
  pageToolsPostMessage,
  type PageToolsChannel,
  type PageToolsPostCommand,
  parsePageToolsPostEvent,
} from "./pageToolsScript";
import { IframeWebview } from "./iframeWebview";

type MessageHost = Pick<Window, "addEventListener" | "removeEventListener">;

/** A fresh token for the site's page (null — none: the page stays silent). */
export type SiteTokenSource = () => Promise<string | null>;

export class PostMessageWebview extends IframeWebview {
  readonly pageToolsChannel: PageToolsChannel = "postMessage";
  private lastUrl: string | null = null;
  /** Calls made while `setNonce` waits for its token; null — none waiting. */
  private waiting: PageToolsPostCommand[] | null = null;
  private disposed = false;

  constructor(
    iframe: HTMLIFrameElement,
    /** The port's (or the site's) origin: the only one we talk to. */
    readonly origin: string,
    private readonly host: MessageHost = window,
    /** A site's page: `setNonce` goes with a token from here. */
    private readonly siteToken: SiteTokenSource | null = null,
  ) {
    super(iframe);
    host.addEventListener("message", this.onMessage);
  }

  override dispose(): void {
    this.disposed = true;
    this.waiting = null;
    this.host.removeEventListener("message", this.onMessage);
    super.dispose();
  }

  /**
   * Another origin: the address is what the page last told us; before that
   * (a page without the script — JSON, an image) the one we loaded, the
   * one-time entry read as the page it leads to.
   */
  protected override readUrl(): string {
    if (this.lastUrl) return this.lastUrl;
    const src = this.iframe.src;
    try {
      const url = new URL(src);
      const next = url.searchParams.get("next");
      if (!this.siteToken && url.pathname === "/enter" && next?.startsWith("/")) {
        return `${url.origin}${next}`;
      }
    } catch {
      // not a URL
    }
    return src;
  }

  override loadURL(url: string): Promise<void> {
    this.lastUrl = null;
    return super.loadURL(url);
  }

  private onMessage = (event: MessageEvent): void => {
    if (event.origin !== this.origin || event.source !== this.iframe.contentWindow) return;
    const message = parsePageToolsPostEvent(event.data);
    if (!message) return;
    if (message.kind === "nav") {
      this.lastUrl = message.url;
      this.emit("did-navigate-in-page", { url: message.url, isMainFrame: true });
      if (message.title) this.emit("page-title-updated", { title: message.title });
      return;
    }
    this.emit("console-message", { message: message.line, level: "debug" });
  };

  /** A call into the page's script (dropped by a page without it). */
  postPageTools(command: PageToolsPostCommand): void {
    if (this.waiting) {
      this.waiting.push(command);
      return;
    }
    if (command.method === "setNonce" && this.siteToken) {
      const waiting: PageToolsPostCommand[] = [];
      this.waiting = waiting;
      const send = (token: string | null) => {
        if (this.disposed || this.waiting !== waiting) return;
        this.waiting = null;
        if (token) this.post({ ...command, token });
        for (const later of waiting) this.postPageTools(later);
      };
      this.siteToken().then(send, () => send(null));
      return;
    }
    this.post(command);
  }

  private post(command: PageToolsPostCommand): void {
    try {
      this.iframe.contentWindow?.postMessage(pageToolsPostMessage(command), this.origin);
    } catch {
      // the frame is gone
    }
  }

  override executeJavaScript(): Promise<unknown> {
    return Promise.reject(new Error("The page is on another origin."));
  }
}
