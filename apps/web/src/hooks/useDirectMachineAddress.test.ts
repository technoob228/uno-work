import { describe, expect, it, vi } from "vitest";

vi.mock("../environments/primary", () => ({ usePrimaryEnvironmentDescriptor: vi.fn() }));
vi.mock("../lib/workspaceReactQuery", () => ({ unoCloudStateQueryOptions: vi.fn() }));

import { isWorkProxyHost, resolveDirectMachineBaseUrl } from "./useDirectMachineAddress";

const BOX = { hostname: "work-85.app.uno4.dev", url: "https://work-85.app.uno4.dev" };

describe("resolveDirectMachineBaseUrl", () => {
  it("uses the box's own address when Work was opened through app.uno4.work", () => {
    expect(
      resolveDirectMachineBaseUrl({
        pageUrl: "https://app.uno4.work/settings/app/phone",
        box: BOX,
      }),
    ).toBe("https://work-85.app.uno4.dev");
  });

  it("keeps the page origin when the page is served by the box itself", () => {
    expect(
      resolveDirectMachineBaseUrl({ pageUrl: "https://work-85.app.uno4.dev/settings", box: BOX }),
    ).toBeNull();
  });

  it("falls back to https://hostname when the box has no url yet", () => {
    expect(
      resolveDirectMachineBaseUrl({
        pageUrl: "https://app.uno4.work/",
        box: { hostname: "b.app.uno4.dev", url: null },
      }),
    ).toBe("https://b.app.uno4.dev");
  });

  it("recognises the proxy host", () => {
    expect(isWorkProxyHost("https://app.uno4.work/pair")).toBe(true);
    expect(isWorkProxyHost("https://work-85.app.uno4.dev")).toBe(false);
  });
});
