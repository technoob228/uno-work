import { describe, expect, it } from "vitest";

import { inAppBrowserName } from "./inAppBrowser";

describe("inAppBrowserName", () => {
  it("names Telegram's browser, by its bridge or its user agent", () => {
    expect(inAppBrowserName({ telegramWebview: true })).toBe("Telegram");
    expect(
      inAppBrowserName({
        userAgent:
          "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36 Telegram-Android/11.2.3",
      }),
    ).toBe("Telegram");
    expect(inAppBrowserName({ userAgent: "Mozilla/5.0 Instagram 300.0" })).toBe("Instagram");
  });

  it("a regular browser and the desktop app are not in-app", () => {
    expect(
      inAppBrowserName({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
      }),
    ).toBeNull();
    expect(inAppBrowserName({ telegramWebview: true, desktop: true })).toBeNull();
    expect(inAppBrowserName({})).toBeNull();
  });
});
