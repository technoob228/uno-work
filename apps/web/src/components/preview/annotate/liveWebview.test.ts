import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { boxPointToPage, fitFrame } from "./liveFrame.logic";
import { LIVE_POLL_FAST_MS, LivePageView, parseDrained } from "./liveWebview";
import { PAGE_TOOLS_DRAIN_EXPRESSION, pageToolsPointerCall } from "./pageToolsScript";

describe("parseDrained", () => {
  it("tells a page without the script from one with nothing new", () => {
    expect(parseDrained(null)).toBeNull();
    expect(parseDrained("null")).toBeNull();
    expect(parseDrained("[]")).toEqual([]);
    expect(parseDrained('["n:{\\"type\\":\\"ready\\"}", 3]')).toEqual(['n:{"type":"ready"}']);
    // An odd answer is not "the script is gone".
    expect(parseDrained('{"x":1}')).toEqual([]);
    expect(parseDrained("not json")).toEqual([]);
  });
});

describe("pageToolsPointerCall", () => {
  it("passes whole page pixels and never anything but numbers", () => {
    expect(pageToolsPointerCall("pickAt", [10.4, 20.6])).toContain("t.pickAt(10,21)");
    expect(pageToolsPointerCall("areaAt", [1, 2, Number.NaN, 4])).toContain("t.areaAt(1,2,0,4)");
  });
});

describe("fitFrame / boxPointToPage", () => {
  const frame = { width: 1280, height: 800 };

  it("fits the page into a narrow panel, at the top or centred", () => {
    const top = fitFrame({ width: 640, height: 900 }, frame, true)!;
    expect(top.scale).toBe(0.5);
    expect(top.offsetX).toBe(0);
    expect(top.offsetY).toBe(0);
    expect(top.height).toBe(400);
    const centred = fitFrame({ width: 640, height: 900 }, frame, false)!;
    expect(centred.offsetY).toBe(250);
    // A wide box: bands left and right.
    const wide = fitFrame({ width: 2000, height: 400 }, frame, true)!;
    expect(wide.scale).toBe(0.5);
    expect(wide.offsetX).toBe(680);
    expect(fitFrame({ width: 0, height: 100 }, frame, true)).toBeNull();
    expect(fitFrame({ width: 100, height: 100 }, { width: 0, height: 0 }, true)).toBeNull();
  });

  it("maps the pointer to page pixels and back (the note box goes by the same fit)", () => {
    const fit = fitFrame({ width: 640, height: 900 }, frame, false)!;
    expect(boxPointToPage({ x: 320, y: 450 }, fit, frame)).toEqual({ x: 640, y: 400 });
    // The band above the picture is not the page.
    expect(boxPointToPage({ x: 320, y: 100 }, fit, frame)).toBeNull();
    // Page rect → box: x * scale + offset.
    const rect = { x: 100, y: 40 };
    expect(rect.x * fit.scale + fit.offsetX).toBe(50);
    expect(rect.y * fit.scale + fit.offsetY).toBe(270);
  });
});

describe("LivePageView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const makeApi = (answers: Array<string | null>) => {
    const calls: string[] = [];
    const api = {
      evaluate: vi.fn(async (input: { pageId: string; expression: string }) => {
        calls.push(input.expression);
        if (input.expression === PAGE_TOOLS_DRAIN_EXPRESSION) {
          return { json: answers.length > 0 ? answers.shift()! : "[]" };
        }
        return { json: "true" };
      }),
      capture: vi.fn(async () => ({ data: btoa("png"), width: 1, height: 1 })),
    };
    return { api, calls };
  };

  it("asks for the script again on a new document and hands the page's lines on", async () => {
    const { api } = makeApi(["null", '["n:{\\"type\\":\\"ready\\",\\"data\\":{}}"]']);
    const view = new LivePageView(api, "p1");
    const events: string[] = [];
    view.addEventListener("dom-ready", () => events.push("dom-ready"));
    view.addEventListener("console-message", (event) =>
      events.push(`console:${(event as Event & { message: string }).message}`),
    );
    view.setFast(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(LIVE_POLL_FAST_MS);
    expect(events).toEqual(["dom-ready", 'console:n:{"type":"ready","data":{}}']);
    view.dispose();
  });

  it("keeps only the newest hover while one is on its way, and reads the queue right after a pick", async () => {
    const { api, calls } = makeApi([]);
    const view = new LivePageView(api, "p1");
    await vi.advanceTimersByTimeAsync(0);
    calls.length = 0;
    view.pointer("hoverAt", [1, 1]);
    view.pointer("hoverAt", [2, 2]);
    view.pointer("hoverAt", [3, 3]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((call) => call.includes("hoverAt"))).toEqual([
      pageToolsPointerCall("hoverAt", [1, 1]),
      pageToolsPointerCall("hoverAt", [3, 3]),
    ]);
    calls.length = 0;
    view.pointer("pickAt", [5, 6]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([pageToolsPointerCall("pickAt", [5, 6]), PAGE_TOOLS_DRAIN_EXPRESSION]);
    view.dispose();
  });

  it("turns the computer's picture into a PNG blob", async () => {
    const { api } = makeApi([]);
    const view = new LivePageView(api, "p1");
    const blob = await view.capture({ x: 1, y: 2, w: 3, h: 4 });
    expect(blob?.type).toBe("image/png");
    expect(api.capture).toHaveBeenCalledWith({ pageId: "p1", x: 1, y: 2, width: 3, height: 4 });
    view.dispose();
  });
});
