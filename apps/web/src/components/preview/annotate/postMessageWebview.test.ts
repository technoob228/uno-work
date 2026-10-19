import { describe, expect, it } from "vitest";

import { cloudComputerFromDescriptor } from "../portPreview";
import { PostMessageWebview } from "./postMessageWebview";
import {
  buildPageToolsScript,
  buildSitePageToolsScript,
  SITE_PAGE_TOOLS_VERIFY_PATH,
  PAGE_TOOLS_MESSAGE_KEY,
  pageToolsPostMessage,
  parsePageToolsMessage,
  parsePageToolsPostEvent,
} from "./pageToolsScript";

const PORT_ORIGIN = "https://p5173--abc123.uno4.work";
const WORK_ORIGIN = "https://abc123.uno4.work";

describe("parsePageToolsPostEvent", () => {
  it("takes only our messages", () => {
    expect(parsePageToolsPostEvent({ [PAGE_TOOLS_MESSAGE_KEY]: true, line: "n:{}" })).toEqual({
      kind: "line",
      line: "n:{}",
    });
    expect(
      parsePageToolsPostEvent({
        [PAGE_TOOLS_MESSAGE_KEY]: true,
        nav: { url: "https://x/", title: 1 },
      }),
    ).toEqual({ kind: "nav", url: "https://x/", title: "" });
    expect(parsePageToolsPostEvent({ line: "n:{}" })).toBeNull();
    expect(parsePageToolsPostEvent("n:{}")).toBeNull();
    expect(parsePageToolsPostEvent(null)).toBeNull();
  });
});

/** XMLHttpRequest as far as the script patches it. */
function Xhr() {}
Xhr.prototype.open = () => {};
Xhr.prototype.send = () => {};

/** A page in a frame: just enough of a browser window for the script. */
function fakeFramedPage(options: {
  framed: boolean;
  /** A site's page (the console's script): its own host and the verify answer. */
  site?: { host: string; verify: (body: { token: string; parentOrigin: string }) => boolean };
  ancestorOrigins?: string[];
}) {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const posted: Array<{ data: Record<string, unknown>; target: string }> = [];
  const parent = {
    postMessage: (data: Record<string, unknown>, target: string) => posted.push({ data, target }),
  };
  const win: Record<string, unknown> = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    fetch: undefined,
  };
  const verifyCalls: Array<{ url: string; body: { token: string; parentOrigin: string } }> = [];
  if (options.site) {
    const verify = options.site.verify;
    win["fetch"] = (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { token: string; parentOrigin: string };
      verifyCalls.push({ url, body });
      const ok = verify(body);
      return Promise.resolve({ ok, json: () => Promise.resolve({ ok }) });
    };
  }
  win["parent"] = options.framed ? parent : win;
  const pageHost = options.site?.host ?? "p5173--abc123.uno4.work";
  const location = {
    href: `https://${pageHost}/about`,
    hostname: pageHost,
    protocol: "https:",
    port: "",
    ancestorOrigins: options.ancestorOrigins,
  };
  const document = { title: "App" };
  const consoleStub = {
    debug: () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    log: () => {},
  };
  const history = { pushState: () => {}, replaceState: () => {} };
  const run = new Function(
    "window",
    "location",
    "document",
    "console",
    "history",
    "XMLHttpRequest",
    "performance",
    `return ${options.site ? buildSitePageToolsScript() : buildPageToolsScript("", "postMessage")}`,
  ) as (...args: unknown[]) => unknown;
  const result = run(win, location, document, consoleStub, history, Xhr, {
    getEntriesByType: () => [],
  });
  const dispatch = (type: string, event: unknown) =>
    (listeners.get(type) ?? []).forEach((listener) => listener(event));
  return { result, posted, parent, win, dispatch, history, verifyCalls };
}

/** Let the page's verify request (a resolved promise chain) finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("page script, postMessage channel", () => {
  it("does nothing outside a frame", () => {
    const page = fakeFramedPage({ framed: false });
    expect(page.result).toBe("standalone");
    expect(page.posted).toEqual([]);
  });

  it("tells where it is, holds its lines until the host's nonce, then talks to Work's origin only", () => {
    const page = fakeFramedPage({ framed: true });
    expect(page.result).toBe("installed");
    expect(page.posted.every((entry) => entry.target === WORK_ORIGIN)).toBe(true);
    expect(page.posted.map((entry) => entry.data["nav"])).toEqual([
      { url: `${PORT_ORIGIN}/about`, title: "App" },
    ]);

    // Another origin can't hand out the nonce.
    page.dispatch("message", {
      source: page.parent,
      origin: "https://evil.example",
      data: pageToolsPostMessage({ method: "setNonce", arg: "n:" }),
    });
    expect(page.posted).toHaveLength(1);

    page.dispatch("message", {
      source: page.parent,
      origin: WORK_ORIGIN,
      data: pageToolsPostMessage({ method: "setNonce", arg: "n:" }),
    });
    const lines = page.posted
      .map((entry) => entry.data["line"])
      .filter((line): line is string => typeof line === "string");
    expect(lines.length).toBeGreaterThan(0);
    expect(parsePageToolsMessage("n:", lines[0])?.type).toBe("ready");

    // In-page moves are reported too.
    (page.history.pushState as () => void)();
    expect(page.posted.at(-1)?.data["nav"]).toEqual({ url: `${PORT_ORIGIN}/about`, title: "App" });
  });

  it("talks to its own Work only, whatever other *.uno4.work frames it", () => {
    const page = fakeFramedPage({
      framed: true,
      ancestorOrigins: ["https://p3000--evil999.uno4.work"],
    });
    expect(page.posted.every((entry) => entry.target === WORK_ORIGIN)).toBe(true);
    page.dispatch("message", {
      source: page.parent,
      origin: "https://evil999.uno4.work",
      data: pageToolsPostMessage({ method: "setNonce", arg: "n:" }),
    });
    expect(page.posted.some((entry) => typeof entry.data["line"] === "string")).toBe(false);
  });

  it("stays silent on a host that isn't a port's", () => {
    const other = new Function(
      "window",
      "location",
      "document",
      "console",
      "history",
      "XMLHttpRequest",
      "performance",
      `return ${buildPageToolsScript("", "postMessage")}`,
    ) as (...args: unknown[]) => unknown;
    const posted: unknown[] = [];
    const win: Record<string, unknown> = { addEventListener: () => {} };
    win["parent"] = { postMessage: (data: unknown) => posted.push(data) };
    expect(
      other(
        win,
        { href: "https://example.com/", hostname: "example.com", protocol: "https:", port: "" },
        { title: "" },
        { debug() {}, error() {}, warn() {}, info() {}, log() {} },
        { pushState() {}, replaceState() {} },
        Xhr,
        { getEntriesByType: () => [] },
      ),
    ).toBe("no-parent");
    expect(posted).toEqual([]);
  });
});

describe("page script, a site of the person (verified parent)", () => {
  const SITE = "cafe.uno4.me";
  const TOKEN = "v1.good";
  const verify = (body: { token: string; parentOrigin: string }) =>
    body.token === TOKEN && body.parentOrigin === WORK_ORIGIN;

  it("says nothing until a parent's token is confirmed for that parent", async () => {
    const page = fakeFramedPage({ framed: true, site: { host: SITE, verify } });
    expect(page.result).toBe("installed");
    // Not even its address before the token.
    expect(page.posted).toEqual([]);

    // No token, a wrong token, a token for another parent: silence.
    page.dispatch("message", {
      source: page.parent,
      origin: WORK_ORIGIN,
      data: pageToolsPostMessage({ method: "setNonce", arg: "n:" }),
    });
    page.dispatch("message", {
      source: page.parent,
      origin: "https://evil999.uno4.work",
      data: pageToolsPostMessage({ method: "setNonce", arg: "n:", token: TOKEN }),
    });
    await settle();
    page.dispatch("message", {
      source: page.parent,
      origin: WORK_ORIGIN,
      data: pageToolsPostMessage({ method: "setNonce", arg: "n:", token: "v1.bad" }),
    });
    await settle();
    expect(page.posted).toEqual([]);
    expect(page.verifyCalls.map((call) => call.url)).toEqual([
      SITE_PAGE_TOOLS_VERIFY_PATH,
      SITE_PAGE_TOOLS_VERIFY_PATH,
    ]);
    expect(page.verifyCalls[0]?.body).toEqual({
      token: TOKEN,
      parentOrigin: "https://evil999.uno4.work",
    });

    // The owner's Work with its token: the page talks to it, and only to it.
    page.dispatch("message", {
      source: page.parent,
      origin: WORK_ORIGIN,
      data: pageToolsPostMessage({ method: "setNonce", arg: "n:", token: TOKEN }),
    });
    // A call made while the token is checked waits and is applied after.
    page.dispatch("message", {
      source: page.parent,
      origin: WORK_ORIGIN,
      data: pageToolsPostMessage({ method: "setNonce", arg: "n2:" }),
    });
    await settle();
    expect(page.posted.length).toBeGreaterThan(0);
    expect(page.posted.every((entry) => entry.target === WORK_ORIGIN)).toBe(true);
    expect(page.posted[0]?.data["nav"]).toEqual({ url: `https://${SITE}/about`, title: "App" });
    const firstLine = page.posted
      .map((entry) => entry.data["line"])
      .find((line): line is string => typeof line === "string");
    expect(parsePageToolsMessage("n:", firstLine)?.type).toBe("ready");
    expect((page.win["__unoPageTools"] as { nonce: string }).nonce).toBe("n2:");

    // Another origin can't take it over afterwards.
    page.dispatch("message", {
      source: page.parent,
      origin: "https://evil999.uno4.work",
      data: pageToolsPostMessage({ method: "setNonce", arg: "evil:", token: TOKEN }),
    });
    await settle();
    expect((page.win["__unoPageTools"] as { nonce: string }).nonce).toBe("n2:");
  });

  it("does nothing outside a frame", () => {
    const page = fakeFramedPage({ framed: false, site: { host: SITE, verify } });
    expect(page.result).toBe("standalone");
  });
});

describe("PostMessageWebview", () => {
  function setup() {
    const contentWindow = {
      posted: [] as unknown[],
      postMessage(data: unknown, target: string) {
        this.posted.push({ data, target });
      },
    };
    const iframe = {
      src: `${PORT_ORIGIN}/enter?t=x`,
      contentWindow,
      contentDocument: null,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as HTMLIFrameElement;
    let onMessage: ((event: MessageEvent) => void) | null = null;
    const host = {
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        onMessage = listener;
      },
      removeEventListener: () => {
        onMessage = null;
      },
    } as unknown as Pick<Window, "addEventListener" | "removeEventListener">;
    const view = new PostMessageWebview(iframe, PORT_ORIGIN, host);
    const send = (origin: string, data: unknown, source: unknown = contentWindow) =>
      onMessage?.({ origin, data, source } as MessageEvent);
    return { view, send, contentWindow, isListening: () => onMessage !== null };
  }

  it("turns the page's messages into webview events and posts calls to the port only", () => {
    const { view, send, contentWindow } = setup();
    const events: Array<{ type: string; url?: string; message?: string; title?: string }> = [];
    for (const type of ["did-navigate-in-page", "page-title-updated", "console-message"]) {
      view.addEventListener(type, (event) => events.push(Object.assign({ type }, event) as never));
    }
    send(PORT_ORIGIN, {
      [PAGE_TOOLS_MESSAGE_KEY]: true,
      nav: { url: `${PORT_ORIGIN}/a`, title: "A" },
    });
    send(PORT_ORIGIN, { [PAGE_TOOLS_MESSAGE_KEY]: true, line: "n:{}" });
    send("https://evil.example", { [PAGE_TOOLS_MESSAGE_KEY]: true, line: "n:evil" });
    send(PORT_ORIGIN, { [PAGE_TOOLS_MESSAGE_KEY]: true, line: "n:other" }, {});
    expect(events.map((event) => event.type)).toEqual([
      "did-navigate-in-page",
      "page-title-updated",
      "console-message",
    ]);
    expect(events[0]?.url).toBe(`${PORT_ORIGIN}/a`);
    expect(events[2]?.message).toBe("n:{}");
    expect(view.getURL()).toBe(`${PORT_ORIGIN}/a`);
    expect(view.pageToolsChannel).toBe("postMessage");

    view.postPageTools({ method: "setMode", arg: "comment" });
    expect(contentWindow.posted).toEqual([
      {
        data: { [PAGE_TOOLS_MESSAGE_KEY]: true, method: "setMode", arg: "comment" },
        target: PORT_ORIGIN,
      },
    ]);
  });

  it("reads the one-time entry as the page it leads to until the page speaks", () => {
    const { view } = setup();
    expect(view.getURL()).toBe(`${PORT_ORIGIN}/enter?t=x`);
    const withNext = setup();
    (withNext.view.iframe as { src: string }).src =
      `${PORT_ORIGIN}/enter?t=x&next=%2Fabout%3Fq%3D1`;
    expect(withNext.view.getURL()).toBe(`${PORT_ORIGIN}/about?q=1`);
  });

  it("sends a site's setNonce with a fresh token, and later calls after it, in order", async () => {
    const contentWindow = {
      posted: [] as Array<{ data: Record<string, unknown>; target: string }>,
      postMessage(data: Record<string, unknown>, target: string) {
        this.posted.push({ data, target });
      },
    };
    const iframe = {
      src: "https://cafe.uno4.me/enter?next=%2Fx",
      contentWindow,
      contentDocument: null,
      addEventListener: () => {},
      removeEventListener: () => {},
    } as unknown as HTMLIFrameElement;
    const host = { addEventListener: () => {}, removeEventListener: () => {} };
    let release: (token: string | null) => void = () => {};
    const view = new PostMessageWebview(
      iframe,
      "https://cafe.uno4.me",
      host,
      () => new Promise((resolve) => (release = resolve)),
    );
    // A site's own /enter is just a page.
    expect(view.getURL()).toBe("https://cafe.uno4.me/enter?next=%2Fx");
    view.postPageTools({ method: "setNonce", arg: "n:" });
    view.postPageTools({ method: "setMode", arg: "comment" });
    expect(contentWindow.posted).toEqual([]);
    release("v1.tok");
    await Promise.resolve();
    await Promise.resolve();
    expect(contentWindow.posted.map((entry) => entry.data["method"])).toEqual([
      "setNonce",
      "setMode",
    ]);
    expect(contentWindow.posted[0]?.data["token"]).toBe("v1.tok");
    expect(contentWindow.posted.every((entry) => entry.target === "https://cafe.uno4.me")).toBe(
      true,
    );
  });

  it("stops listening when disposed", () => {
    const { view, isListening } = setup();
    expect(isListening()).toBe(true);
    view.dispose();
    expect(isListening()).toBe(false);
  });
});

describe("cloudComputerFromDescriptor", () => {
  it("knows an Uno box, with or without its id", () => {
    expect(cloudComputerFromDescriptor({ machineKind: "uno_box", unoBoxId: 12 })).toEqual({
      boxId: 12,
    });
    expect(cloudComputerFromDescriptor({ machineKind: "uno_box" })).toEqual({ boxId: null });
    expect(cloudComputerFromDescriptor({}, 7)).toEqual({ boxId: 7 });
    expect(cloudComputerFromDescriptor({ machineKind: "computer" })).toBeNull();
    expect(cloudComputerFromDescriptor(null)).toBeNull();
  });
});
