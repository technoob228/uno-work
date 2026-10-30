/**
 * The agent's look at its own page (`html_preview`): the page in the same two
 * frames and under the same rules as in the chat, in a browser of its own.
 *
 * Never the person's browser: `serverBrowser` keeps their sign-ins in a
 * persistent profile, and a page's script has no business near them. This one
 * has an empty context, lives for one picture, and answers every request
 * itself: nothing but the public libraries leaves the computer, so a page
 * can't reach `localhost` or the cloud's metadata address from here.
 */
import {
  HTML_RENDER_FONT_HOSTS,
  HTML_RENDER_LIBRARY_HOSTS,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MEASURE_FONTS,
  HTML_RENDER_SANDBOX,
  HTML_RENDER_SIZE_CHANGED_METHOD,
  htmlRenderFrameDocument,
  htmlRenderTheme,
  withHtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import { UNO_DARK_THEME_COLORS, UNO_LIGHT_THEME_COLORS } from "@t3tools/shared/themePalettes";
import type { Browser, Route } from "playwright-core";

export interface PageCaptureInput {
  readonly html: string;
  readonly width: number;
  readonly appearance: "dark" | "light";
}

export interface PageCapture {
  /** PNG, base64. */
  readonly png: string;
  readonly contentHeight: number;
  readonly capturedHeight: number;
  readonly consoleMessages: ReadonlyArray<{ readonly level: string; readonly text: string }>;
  readonly blockedRequests: ReadonlyArray<string>;
}

const HOST_URL = "https://page.uno-work.invalid/";
const LOAD_TIMEOUT_MS = 15_000;
const SETTLE_LIMIT_MS = 4_000;
const SETTLE_QUIET_MS = 350;
const MAX_CONSOLE_MESSAGES = 30;
const MAX_CONSOLE_CHARS = 500;
const MAX_BLOCKED = 20;
const FIRST_VIEWPORT_HEIGHT = 800;

const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  ...HTML_RENDER_LIBRARY_HOSTS,
  ...HTML_RENDER_FONT_HOSTS,
]);

const escapeAttribute = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** Exported for tests: only https to the listed hosts goes out. */
export function requestAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function hostDocument(input: PageCaptureInput): string {
  const colors = input.appearance === "light" ? UNO_LIGHT_THEME_COLORS : UNO_DARK_THEME_COLORS;
  const theme = htmlRenderTheme(colors, input.appearance, HTML_RENDER_MEASURE_FONTS);
  const frame = htmlRenderFrameDocument(withHtmlRenderTheme(input.html, theme));
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:${colors.canvas}}` +
    `iframe{display:block;border:0;width:100%;height:${FIRST_VIEWPORT_HEIGHT}px}</style></head>` +
    `<body><iframe id="frame" sandbox="${HTML_RENDER_SANDBOX}" srcdoc="${escapeAttribute(frame)}"></iframe>` +
    `<script>window.__height=0;window.addEventListener("message",function(e){var d=e.data;` +
    `if(d&&d.method===${JSON.stringify(HTML_RENDER_SIZE_CHANGED_METHOD)}&&d.params)window.__height=d.params.height;});</script>` +
    `</body></html>`
  );
}

/** `Refused to load the image 'https://x/y.png' because…` → the address. */
/** Chrome words it per kind of request; the address always comes before the policy. */
const blockedAddress = (text: string) =>
  text.includes("Content Security Policy")
    ? /\b(?:https?|wss?):\/\/[^\s'"]+/.exec(text)?.[0]
    : undefined;

export async function capturePage(
  browser: Browser,
  input: PageCaptureInput,
): Promise<PageCapture> {
  const consoleMessages: Array<{ level: string; text: string }> = [];
  const blocked = new Set<string>();
  const note = (level: string, text: string) => {
    // Our own policy names a directive Chrome doesn't know yet: not the page's fault.
    if (text.startsWith("Unrecognized Content-Security-Policy directive")) return;
    const address = blockedAddress(text);
    if (address !== undefined && blocked.size < MAX_BLOCKED) blocked.add(address);
    if (consoleMessages.length < MAX_CONSOLE_MESSAGES) {
      consoleMessages.push({ level, text: text.slice(0, MAX_CONSOLE_CHARS) });
    }
  };
  const context = await browser.newContext({
    viewport: { width: input.width, height: FIRST_VIEWPORT_HEIGHT },
    colorScheme: input.appearance,
    deviceScaleFactor: 1,
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  try {
    const page = await context.newPage();
    const answer = (route: Route) => {
      const url = route.request().url();
      if (url === HOST_URL) {
        return route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: hostDocument(input),
        });
      }
      if (requestAllowed(url)) return route.continue();
      if (blocked.size < MAX_BLOCKED) blocked.add(url);
      return route.abort("blockedbyclient");
    };
    await page.route("**/*", answer);
    page.on("console", (message) => {
      note(message.type(), message.text());
    });
    page.on("pageerror", (error) => {
      note("error", error.message);
    });
    await page.goto(HOST_URL, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
    // The page says its height when it loads and whenever it changes:
    // done when it has been quiet for a moment (charts draw after load).
    const started = Date.now();
    let height = 0;
    let quietSince = Date.now();
    while (Date.now() - started < SETTLE_LIMIT_MS) {
      const current = await page.evaluate<number>("window.__height");
      if (current !== height) {
        height = current;
        quietSince = Date.now();
      } else if (height > 0 && Date.now() - quietSince >= SETTLE_QUIET_MS) {
        break;
      }
      await page.waitForTimeout(80);
    }
    const contentHeight = Math.ceil(height);
    const capturedHeight = Math.max(80, Math.min(contentHeight, HTML_RENDER_MAX_HEIGHT));
    await page.setViewportSize({ width: input.width, height: capturedHeight });
    await page.evaluate(`document.getElementById("frame").style.height="${capturedHeight}px"`);
    await page.waitForTimeout(120);
    const screenshot = await page.screenshot({ type: "png" });
    return {
      png: screenshot.toString("base64"),
      contentHeight,
      capturedHeight,
      consoleMessages,
      blockedRequests: [...blocked],
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}
