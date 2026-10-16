import { describe, expect, it } from "vitest";

import {
  allErrorsPayload,
  commentsPayload,
  commentsTitle,
  type ConsoleEntry,
  consolePayload,
  debugBadge,
  formatDuration,
  type NetworkEntry,
  type PageComment,
  pagePath,
  pushCapped,
  renumberComments,
  requestPayload,
} from "./pageTools.logic";

const comment = (n: number, patch: Partial<PageComment> = {}): PageComment => ({
  id: `c${n}`,
  n,
  kind: "element",
  selector: "button.cta",
  label: "button.cta",
  text: "Start free trial",
  note: "Make it full width on phones",
  docRect: { x: 10, y: 20, w: 200, h: 40 },
  ...patch,
});

const error: ConsoleEntry = {
  id: "e1",
  level: "error",
  message: "TypeError: Cannot read properties of undefined (reading 'track')",
  stack:
    "TypeError: Cannot read properties of undefined (reading 'track')\n    at http://x/site.js:12:15",
  source: "site.js:12",
  at: 1,
};
const warning: ConsoleEntry = {
  ...error,
  id: "w1",
  level: "warn",
  message: "No yearly price",
  stack: null,
};
const failed: NetworkEntry = {
  id: "n1",
  method: "POST",
  url: "http://localhost:5791/api/order",
  status: 500,
  statusText: "Internal Server Error",
  type: "fetch",
  durationMs: 84,
  requestBody: '{"plan":"team"}',
  responseBody: '{"error":"price id is not set"}',
  at: 2,
};
const ok: NetworkEntry = {
  ...failed,
  id: "n2",
  status: 200,
  statusText: "OK",
  url: "http://x/app.css",
};

describe("pagePath", () => {
  it("the path a person recognises", () => {
    expect(pagePath("http://localhost:5173/pricing")).toBe("/pricing");
    expect(pagePath("http://localhost:5791/demo-site/pricing.html")).toBe("/demo-site/pricing");
    expect(pagePath("https://site.uno4.me/")).toBe("/");
    expect(pagePath("https://site.uno4.me/blog/index.html")).toBe("/blog");
    expect(pagePath("not a url")).toBe("not a url");
  });
});

describe("debugBadge", () => {
  it("counts errors and failed requests; warnings only when there are no errors", () => {
    expect(debugBadge([error, warning], [failed, ok])).toEqual({ count: 2, tone: "error" });
    expect(debugBadge([warning], [ok])).toEqual({ count: 1, tone: "warn" });
    expect(debugBadge([], [ok])).toBeNull();
  });

  it("a request with no answer is a failure", () => {
    expect(debugBadge([], [{ status: null }])).toEqual({ count: 1, tone: "error" });
  });
});

describe("comments", () => {
  it("title says how many and where", () => {
    expect(commentsTitle(1, "/pricing")).toBe("1 comment on /pricing");
    expect(commentsTitle(3, "/pricing")).toBe("3 comments on /pricing");
  });

  it("pins stay 1, 2, 3 after one is removed", () => {
    const left = renumberComments([comment(1), comment(3), comment(4)]);
    expect(left.map((c) => c.n)).toEqual([1, 2, 3]);
  });

  it("one card for all comments; the file has selectors and notes", () => {
    const payload = commentsPayload({
      page: "http://localhost:5173/pricing",
      comments: [
        comment(1),
        comment(2, {
          kind: "area",
          selector: null,
          label: "Area 320×120",
          text: "h3, p",
          note: "Too much text here",
          docRect: { x: 40, y: 600, w: 320, h: 120 },
        }),
      ],
    });
    expect(payload.card.title).toBe("2 comments on /pricing");
    expect(payload.card.chip).toBe("2 comments · /pricing");
    expect(payload.card.preview).toBe("Make it full width on phones");
    expect(payload.card.items).toHaveLength(2);
    expect(payload.fileName).toBe("comments-pricing.md");
    expect(payload.markdown).toContain("`button.cta` — “Start free trial”");
    expect(payload.markdown).toContain("Make it full width on phones");
    expect(payload.markdown).toContain("Area 320×120 at (40, 600)");
  });
});

describe("Ask agent to fix", () => {
  it("an error goes with its stack", () => {
    const payload = consolePayload({ page: "http://x/pricing", entry: error });
    expect(payload.card.title).toBe("Error on /pricing");
    expect(payload.markdown).toContain("at http://x/site.js:12:15");
  });

  it("a request goes with what was sent and what came back", () => {
    const payload = requestPayload({ page: "http://x/pricing", entry: failed });
    expect(payload.card.title).toBe("POST /api/order · 500");
    expect(payload.markdown).toContain('{"plan":"team"}');
    expect(payload.markdown).toContain("price id is not set");
    expect(payload.markdown).toContain("500 Internal Server Error in 84 ms");
  });

  it("fix all: console errors and failed requests — the Errors button's count", () => {
    const payload = allErrorsPayload({
      page: "http://x/pricing",
      console: [error, warning, { ...error, id: "l", level: "log", message: "hello" }],
      network: [failed, ok],
    });
    expect(payload?.card.title).toBe("2 errors on /pricing");
    expect(payload?.markdown).not.toContain("No yearly price");
    expect(payload?.markdown).not.toContain("hello");
    expect(payload?.markdown).not.toContain("app.css");
    expect(allErrorsPayload({ page: "http://x/", console: [], network: [ok] })).toBeNull();
  });
});

describe("helpers", () => {
  it("lists keep the newest lines", () => {
    expect(pushCapped([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });

  it("durations", () => {
    expect(formatDuration(84.4)).toBe("84 ms");
    expect(formatDuration(1420)).toBe("1.4 s");
    expect(formatDuration(null)).toBe("");
  });
});
