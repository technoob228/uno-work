import { describe, expect, it } from "vitest";

import {
  generatePanelTokenSecret,
  isPanelTokenFresh,
  PANEL_TOKEN_LOAD_WINDOW_MS,
  pluginPanelUrl,
  signPanelToken,
  verifyPanelTokenSignature,
} from "./panelTokens.ts";

const secret = new Uint8Array(32).fill(1);
const binding = { secret, pluginId: "deploys", panelPath: "panel/index.html" };

describe("plugin panel tokens", () => {
  it("round-trips and returns the issue time", () => {
    const token = signPanelToken({ ...binding, issuedAtMs: 1_700_000_000_000 });
    expect(token).toMatch(/^[0-9a-z]+\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(verifyPanelTokenSignature({ ...binding, token })).toBe(1_700_000_000_000);
  });

  it("is bound to the secret, plugin id and panel path", () => {
    const token = signPanelToken({ ...binding, issuedAtMs: Date.now() });
    expect(
      verifyPanelTokenSignature({ ...binding, secret: generatePanelTokenSecret(), token }),
    ).toBeNull();
    expect(verifyPanelTokenSignature({ ...binding, pluginId: "other", token })).toBeNull();
    expect(verifyPanelTokenSignature({ ...binding, panelPath: "ui/index.html", token })).toBeNull();
  });

  it("rejects tampered and malformed tokens", () => {
    const token = signPanelToken({ ...binding, issuedAtMs: 1_000_000 });
    const [issuedAt, nonce, signature] = token.split(".") as [string, string, string];
    // Moving the issue time forward (to extend the lifetime) breaks the MAC.
    const extended = `${(Number.parseInt(issuedAt, 36) + 1).toString(36)}.${nonce}.${signature}`;
    expect(verifyPanelTokenSignature({ ...binding, token: extended })).toBeNull();
    for (const bad of ["", "x", "a.b.c", `${token}x`, token.replace(".", "/"), `../${token}`]) {
      expect(verifyPanelTokenSignature({ ...binding, token: bad })).toBeNull();
    }
  });

  it("uses a fresh nonce per token", () => {
    const now = Date.now();
    expect(signPanelToken({ ...binding, issuedAtMs: now })).not.toBe(
      signPanelToken({ ...binding, issuedAtMs: now }),
    );
  });

  it("checks freshness with a small tolerance for clock skew", () => {
    const nowMs = 10_000_000;
    const maxAgeMs = PANEL_TOKEN_LOAD_WINDOW_MS;
    expect(isPanelTokenFresh({ issuedAtMs: nowMs - maxAgeMs, nowMs, maxAgeMs })).toBe(true);
    expect(isPanelTokenFresh({ issuedAtMs: nowMs - maxAgeMs - 1, nowMs, maxAgeMs })).toBe(false);
    expect(isPanelTokenFresh({ issuedAtMs: nowMs + 1_000, nowMs, maxAgeMs })).toBe(true);
    expect(isPanelTokenFresh({ issuedAtMs: nowMs + 60_000, nowMs, maxAgeMs })).toBe(false);
  });

  it("builds a tokenised panel directory URL", () => {
    expect(pluginPanelUrl("my plugin", "t0k")).toBe("/api/plugins/my%20plugin/panel/t0k/");
  });
});
