import { describe, expect, it } from "vitest";

import { type PageToolsView, pageToolsPreloadServes } from "./usePageTools";

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
