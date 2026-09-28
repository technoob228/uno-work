import { describe, expect, it } from "vitest";

import { expectedAuthCallbackOrigin, isTrustedAuthMessage } from "./setupApi";

describe("expectedAuthCallbackOrigin", () => {
  it("uses the redirect_uri of the provider's authorize URL", () => {
    expect(
      expectedAuthCallbackOrigin(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=" +
          encodeURIComponent("https://console.uno4.dev/api/v1/work/connectors/oauth/callback"),
      ),
    ).toBe("https://console.uno4.dev");
  });

  it("falls back to the URL's own origin and rejects garbage", () => {
    expect(expectedAuthCallbackOrigin("https://console.uno4.dev/start")).toBe(
      "https://console.uno4.dev",
    );
    expect(expectedAuthCallbackOrigin("not a url")).toBeNull();
  });
});

describe("isTrustedAuthMessage", () => {
  const popup = { name: "popup" };
  const expected = { origin: "https://console.uno4.dev", popup, messageType: "uno-slack" };
  const event = (overrides: Partial<Pick<MessageEvent, "origin" | "source" | "data">>) =>
    ({
      origin: "https://console.uno4.dev",
      source: popup,
      data: { type: "uno-slack", ok: true },
      ...overrides,
    }) as Pick<MessageEvent, "origin" | "source" | "data">;

  it("accepts the popup's message from the callback origin", () => {
    expect(isTrustedAuthMessage(event({}), expected)).toBe(true);
  });

  it("rejects another origin, another window, another type or no popup", () => {
    expect(isTrustedAuthMessage(event({ origin: "https://evil.example" }), expected)).toBe(false);
    expect(isTrustedAuthMessage(event({ source: {} as never }), expected)).toBe(false);
    expect(
      isTrustedAuthMessage(event({ data: { type: "uno-connector", ok: true } }), expected),
    ).toBe(false);
    expect(isTrustedAuthMessage(event({ data: null }), expected)).toBe(false);
    expect(isTrustedAuthMessage(event({}), { ...expected, popup: null })).toBe(false);
    expect(isTrustedAuthMessage(event({}), { ...expected, origin: null })).toBe(false);
  });
});
