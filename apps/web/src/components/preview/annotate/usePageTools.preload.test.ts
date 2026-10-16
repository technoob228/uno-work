import { describe, expect, it } from "vitest";

import { commentShotRect, type PageToolsView, pageToolsPreloadServes } from "./usePageTools";

const view = (withSend: boolean): PageToolsView => ({
  executeJavaScript: async () => undefined,
  addEventListener: () => {},
  removeEventListener: () => {},
  ...(withSend ? { send: () => {} } : {}),
});

describe("pageToolsPreloadServes", () => {
  it("uses the desktop's page preload only on a real <webview> of a desktop that has it", () => {
    expect(pageToolsPreloadServes(view(true), { pageTools: { version: 1 } })).toBe(true);
    // Desktop before 0.0.139: no preload — the in-page script.
    expect(pageToolsPreloadServes(view(true), {})).toBe(false);
    expect(pageToolsPreloadServes(view(true), undefined)).toBe(false);
    // The demo's iframe adapter has no `send`.
    expect(pageToolsPreloadServes(view(false), { pageTools: { version: 1 } })).toBe(false);
  });
});

describe("commentShotRect", () => {
  it("takes some room around the element, never past the page's top-left", () => {
    expect(commentShotRect({ x: 100, y: 50, w: 200, h: 40 })).toEqual({
      x: 84,
      y: 34,
      w: 232,
      h: 72,
    });
    expect(commentShotRect({ x: 4, y: 0, w: 50, h: 20 })).toEqual({ x: 0, y: 0, w: 70, h: 36 });
  });
});
