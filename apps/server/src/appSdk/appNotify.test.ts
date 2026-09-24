import { describe, expect, it } from "vitest";

import {
  NOTIFY_BURST,
  NOTIFY_DAILY_MAX,
  NOTIFY_REFILL_MS,
  makeNotifyLimiter,
  parseNotifyBody,
  parseNotifyOpen,
} from "./appNotify.ts";

const ctx = { appId: "notes", home: "/home/unowork" };

describe("App API notify", () => {
  it("accepts a title, a body and the kinds of Open", () => {
    expect(parseNotifyBody({ title: " Hi ", text: "there" }, ctx)).toEqual({
      ok: true,
      value: { title: "Hi", body: "there", open: null, group: null },
    });
    expect(parseNotifyOpen({ file: "~/Documents/a.docx" }, ctx)).toEqual({
      ok: true,
      open: { kind: "file", path: "/home/unowork/Documents/a.docx" },
    });
    expect(parseNotifyOpen("https://example.com/x", ctx)).toEqual({
      ok: true,
      open: { kind: "url", url: "https://example.com/x" },
    });
    expect(parseNotifyOpen({ app: true, path: "/notes/42" }, ctx)).toEqual({
      ok: true,
      open: { kind: "app", appId: "notes", path: "/notes/42" },
    });
  });

  it("refuses files outside home, other apps and odd urls", () => {
    expect(parseNotifyOpen({ file: "/etc/passwd" }, ctx).ok).toBe(false);
    expect(parseNotifyOpen({ file: "~/../other/x" }, ctx).ok).toBe(false);
    expect(parseNotifyOpen({ app: "vaultwarden" }, ctx).ok).toBe(false);
    expect(parseNotifyOpen({ url: "javascript:alert(1)" }, ctx).ok).toBe(false);
    expect(parseNotifyOpen({ app: true, path: "//evil.com" }, ctx).ok).toBe(false);
    expect(parseNotifyBody({}, ctx).ok).toBe(false);
    expect(parseNotifyBody({ title: "x".repeat(141) }, ctx).ok).toBe(false);
  });

  it("rate-limits per app: a burst, then one per refill, and a daily ceiling", () => {
    let now = 0;
    const limiter = makeNotifyLimiter(() => now);
    for (let index = 0; index < NOTIFY_BURST; index += 1) expect(limiter.take("a")).toBeNull();
    expect(limiter.take("a")).toBeGreaterThan(0);
    expect(limiter.take("b")).toBeNull();
    now += NOTIFY_REFILL_MS;
    expect(limiter.take("a")).toBeNull();

    const daily = makeNotifyLimiter(() => now);
    let allowed = 0;
    for (let index = 0; index < NOTIFY_DAILY_MAX + 50; index += 1) {
      now += NOTIFY_REFILL_MS;
      if (daily.take("c") === null) allowed += 1;
    }
    expect(allowed).toBeLessThanOrEqual(NOTIFY_DAILY_MAX);
  });
});
