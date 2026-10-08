import { describe, expect, it } from "vitest";

import { mayReload, staleBundleReloadReason } from "./staleBundle";

describe("staleBundleReloadReason", () => {
  it("asks for a reload when the computer serves another version than this tab runs", () => {
    expect(
      staleBundleReloadReason({
        clientVersion: "0.0.112",
        serverVersion: "0.0.114",
        servedByPrimaryDaemon: true,
      }),
    ).toBe("version:0.0.112->0.0.114");
  });

  it("stays quiet for the same version, an unknown one, or a page from elsewhere", () => {
    const base = {
      clientVersion: "0.0.114",
      serverVersion: "0.0.114",
      servedByPrimaryDaemon: true,
    };
    expect(staleBundleReloadReason(base)).toBeNull();
    expect(staleBundleReloadReason({ ...base, serverVersion: " 0.0.114 " })).toBeNull();
    expect(staleBundleReloadReason({ ...base, serverVersion: "" })).toBeNull();
    expect(staleBundleReloadReason({ ...base, serverVersion: null })).toBeNull();
    // Desktop app, lite build, another computer: their versions differ by design.
    expect(
      staleBundleReloadReason({ ...base, serverVersion: "0.0.115", servedByPrimaryDaemon: false }),
    ).toBeNull();
  });
});

describe("mayReload", () => {
  const now = 1_000_000_000;

  it("reloads the first time and for a new reason", () => {
    expect(mayReload("version:a->b", null, now)).toBe(true);
    expect(mayReload("version:a->c", { reason: "version:a->b", at: now - 1000 }, now)).toBe(true);
  });

  it("doesn't reload twice for the same reason in a row — a reload that didn't help would loop", () => {
    expect(mayReload("version:a->b", { reason: "version:a->b", at: now - 60_000 }, now)).toBe(
      false,
    );
  });

  it("tries again much later", () => {
    expect(mayReload("version:a->b", { reason: "version:a->b", at: now - 11 * 60_000 }, now)).toBe(
      true,
    );
  });
});
