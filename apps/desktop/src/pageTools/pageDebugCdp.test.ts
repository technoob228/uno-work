import { describe, expect, it } from "vitest";

import {
  consoleMessageFallback,
  formatConsoleArgs,
  PageDebugTranslator,
  remoteObjectText,
} from "./pageDebugCdp.ts";

function translator(start = 1_000) {
  let now = start;
  const t = new PageDebugTranslator(() => now);
  return { t, tick: (ms: number) => (now += ms) };
}

describe("console lines", () => {
  it("formats arguments like Chrome's console", () => {
    expect(
      formatConsoleArgs([
        { type: "string", value: "%s has %d items %c!" },
        { type: "string", value: "cart" },
        { type: "number", value: 3.7 },
        { type: "string", value: "color:red" },
        { type: "boolean", value: true },
      ]),
    ).toBe("cart has 3 items ! true");
    expect(
      remoteObjectText({
        type: "object",
        preview: {
          properties: [
            { name: "a", type: "number", value: "1" },
            { name: "b", type: "string", value: "x" },
          ],
          overflow: true,
        },
      }),
    ).toBe('{a: 1, b: "x", …}');
    expect(remoteObjectText({ type: "object", subtype: "null", value: null })).toBe("null");
    expect(remoteObjectText({ type: "undefined" })).toBe("undefined");
  });

  it("keeps errors and warnings with where they came from", () => {
    const { t } = translator();
    const out = t.handle("Runtime.consoleAPICalled", {
      type: "error",
      args: [
        { type: "string", value: "Checkout failed:" },
        {
          type: "object",
          subtype: "error",
          description: "TypeError: x is undefined\n    at pay (https://shop.test/app.js:10:3)",
        },
      ],
      stackTrace: {
        callFrames: [
          {
            functionName: "pay",
            url: "https://shop.test/app.js?v=2",
            lineNumber: 9,
            columnNumber: 2,
          },
        ],
      },
    });
    expect(out.messages).toEqual([
      {
        type: "console",
        data: expect.objectContaining({
          level: "error",
          message: "Checkout failed: TypeError: x is undefined",
          stack: "TypeError: x is undefined\n    at pay (https://shop.test/app.js:10:3)",
          source: "app.js:10",
        }),
      },
    ]);
  });

  it("leaves out Electron's own warnings in the page", () => {
    const { t } = translator();
    expect(
      t.handle("Runtime.consoleAPICalled", {
        type: "warning",
        args: [
          { type: "string", value: "Electron Security Warning (Insecure Content-Security-Policy)" },
        ],
        stackTrace: {
          callFrames: [
            {
              functionName: "warnAboutInsecureCSP",
              url: "node:electron/js2c/sandbox_bundle",
              lineNumber: 1,
            },
          ],
        },
      }).messages,
    ).toEqual([]);
  });

  it("skips what isn't a line (debug, groups)", () => {
    const { t } = translator();
    expect(t.handle("Runtime.consoleAPICalled", { type: "debug", args: [] }).messages).toEqual([]);
    expect(t.handle("Runtime.consoleAPICalled", { type: "startGroup", args: [] }).messages).toEqual(
      [],
    );
    expect(
      t.handle("Runtime.consoleAPICalled", {
        type: "warning",
        args: [{ type: "string", value: "w" }],
      }).messages[0],
    ).toMatchObject({ type: "console", data: { level: "warn", message: "w" } });
  });

  it("reports uncaught errors with their stack", () => {
    const { t } = translator();
    const out = t.handle("Runtime.exceptionThrown", {
      exceptionDetails: {
        text: "Uncaught",
        url: "https://shop.test/app.js",
        lineNumber: 4,
        exception: {
          type: "object",
          subtype: "error",
          description: "Error: boom\n    at https://shop.test/app.js:5:1",
        },
      },
    });
    expect(out.messages[0]).toMatchObject({
      type: "console",
      data: {
        level: "error",
        message: "Uncaught Error: boom",
        stack: "Error: boom\n    at https://shop.test/app.js:5:1",
        source: "app.js:5",
      },
    });
  });

  it("passes the browser's own warnings and errors, not its performance hints", () => {
    const { t } = translator();
    expect(
      t.handle("Log.entryAdded", {
        entry: {
          source: "network",
          level: "error",
          text: "Failed to load resource: the server responded with a status of 404 ()",
          url: "https://shop.test/logo.png",
        },
      }).messages[0],
    ).toMatchObject({ data: { level: "error", source: "logo.png" } });
    expect(
      t.handle("Log.entryAdded", {
        entry: {
          source: "violation",
          level: "warning",
          text: "[Violation] 'click' handler took 200ms",
        },
      }).messages,
    ).toEqual([]);
    expect(
      t.handle("Log.entryAdded", { entry: { source: "other", level: "info", text: "hi" } })
        .messages,
    ).toEqual([]);
  });
});

describe("network", () => {
  it("reports a finished request with its status and time", () => {
    const { t, tick } = translator();
    t.handle("Network.requestWillBeSent", {
      requestId: "1",
      type: "Script",
      request: { url: "https://shop.test/app.js", method: "get" },
    });
    t.handle("Network.responseReceived", {
      requestId: "1",
      response: { status: 200, statusText: "" },
    });
    tick(42);
    const out = t.handle("Network.loadingFinished", { requestId: "1" });
    expect(out.bodyFor).toBeUndefined();
    expect(out.messages[0]).toMatchObject({
      type: "network",
      data: {
        method: "GET",
        url: "https://shop.test/app.js",
        status: 200,
        statusText: "OK",
        type: "script",
        durationMs: 42,
        responseBody: null,
      },
    });
  });

  it("asks for the answer of a failed fetch before reporting it", () => {
    const { t } = translator();
    t.handle("Network.requestWillBeSent", {
      requestId: "2",
      type: "Fetch",
      request: { url: "https://shop.test/api/pay", method: "POST", postData: '{"sum":5}' },
    });
    t.handle("Network.responseReceived", {
      requestId: "2",
      response: { status: 500, statusText: "Internal Server Error" },
    });
    const out = t.handle("Network.loadingFinished", { requestId: "2" });
    expect(out.messages).toEqual([]);
    expect(out.bodyFor?.requestId).toBe("2");
    expect(out.bodyFor?.withBody('{"error":"card declined"}')).toMatchObject({
      type: "network",
      data: {
        status: 500,
        type: "fetch",
        requestBody: '{"sum":5}',
        responseBody: '{"error":"card declined"}',
      },
    });
  });

  it("reports failures without an answer, not cancelled requests", () => {
    const { t } = translator();
    t.handle("Network.requestWillBeSent", {
      requestId: "3",
      type: "XHR",
      request: { url: "https://api.test/x" },
    });
    expect(
      t.handle("Network.loadingFailed", { requestId: "3", errorText: "net::ERR_NAME_NOT_RESOLVED" })
        .messages[0],
    ).toMatchObject({
      data: { status: null, statusText: "net::ERR_NAME_NOT_RESOLVED", type: "xhr" },
    });
    t.handle("Network.requestWillBeSent", { requestId: "4", request: { url: "https://x.test/" } });
    expect(
      t.handle("Network.loadingFailed", {
        requestId: "4",
        errorText: "net::ERR_ABORTED",
        canceled: true,
      }).messages,
    ).toEqual([]);
  });

  it("lists a failed request the Network domain missed, from the browser's own line", () => {
    const { t } = translator();
    const out = t.handle("Log.entryAdded", {
      entry: {
        source: "network",
        level: "error",
        networkRequestId: "9.2",
        url: "https://shop.test/missing.png",
        text: "Failed to load resource: the server responded with a status of 404 (Not Found)",
      },
    });
    expect(out.messages.map((m) => m.type)).toEqual(["console", "network"]);
    expect(out.messages[1]).toMatchObject({
      data: { url: "https://shop.test/missing.png", status: 404, statusText: "Not Found" },
    });
    // Seen by the Network domain: only the console line.
    t.handle("Network.requestWillBeSent", {
      requestId: "9.3",
      request: { url: "https://shop.test/a.js" },
    });
    expect(
      t
        .handle("Log.entryAdded", {
          entry: {
            source: "network",
            level: "error",
            networkRequestId: "9.3",
            url: "https://shop.test/a.js",
            text: "Failed to load resource: net::ERR_FAILED",
          },
        })
        .messages.map((m) => m.type),
    ).toEqual(["console"]);
  });

  it("splits redirects into hops and ignores data: urls", () => {
    const { t } = translator();
    t.handle("Network.requestWillBeSent", {
      requestId: "5",
      type: "Document",
      request: { url: "http://shop.test/" },
    });
    const hop = t.handle("Network.requestWillBeSent", {
      requestId: "5",
      type: "Document",
      request: { url: "https://shop.test/" },
      redirectResponse: { status: 301, statusText: "Moved Permanently" },
    });
    expect(hop.messages[0]).toMatchObject({
      data: { url: "http://shop.test/", status: 301, type: "other" },
    });
    expect(
      t.handle("Network.requestWillBeSent", {
        requestId: "6",
        request: { url: "data:image/png;base64,AAA" },
      }).messages,
    ).toEqual([]);
    expect(t.handle("Network.loadingFinished", { requestId: "6" }).messages).toEqual([]);
  });
});

describe("consoleMessageFallback", () => {
  it("maps Electron's levels, drops verbose", () => {
    expect(
      consoleMessageFallback(
        { level: "warning", message: "careful", sourceId: "https://x.test/a.js", lineNumber: 3 },
        "f1",
        5,
      ),
    ).toEqual({
      type: "console",
      data: { id: "f1", level: "warn", message: "careful", stack: null, source: "a.js:3", at: 5 },
    });
    expect(consoleMessageFallback({ level: "debug", message: "x" }, "f2", 5)).toBeNull();
    expect(consoleMessageFallback({ level: 3, message: "x" }, "f3", 5)?.data).toMatchObject({
      level: "error",
    });
  });
});
