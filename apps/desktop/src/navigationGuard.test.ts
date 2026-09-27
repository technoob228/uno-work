import { describe, expect, it } from "vitest";

import {
  decideMainWindowNavigation,
  isAllowedWebviewUrl,
  isGuestPermissionAllowedByDefault,
  isTrustedAppUrl,
  resolveTrustedOrigins,
} from "./navigationGuard.ts";

const origins = resolveTrustedOrigins(["http://127.0.0.1:13773/", "", null, "file:///x"]);

describe("resolveTrustedOrigins", () => {
  it("keeps only http(s) origins", () => {
    expect([...origins]).toEqual(["http://127.0.0.1:13773"]);
  });
});

describe("isTrustedAppUrl", () => {
  it("accepts the app origin", () => {
    expect(isTrustedAppUrl("http://127.0.0.1:13773/settings?x=1", origins)).toBe(true);
  });
  it("rejects other ports, hosts and schemes", () => {
    expect(isTrustedAppUrl("http://127.0.0.1:13774/", origins)).toBe(false);
    expect(isTrustedAppUrl("http://localhost:13773/", origins)).toBe(false);
    expect(isTrustedAppUrl("file:///etc/passwd", origins)).toBe(false);
    expect(isTrustedAppUrl("https://evil.example/", origins)).toBe(false);
    expect(isTrustedAppUrl(undefined, origins)).toBe(false);
  });
});

describe("decideMainWindowNavigation", () => {
  it("allows in-app navigation", () => {
    expect(decideMainWindowNavigation("http://127.0.0.1:13773/pair", origins)).toEqual({
      kind: "allow",
    });
  });
  it("sends web links to the system browser", () => {
    expect(decideMainWindowNavigation("https://example.com/a", origins)).toEqual({
      kind: "open-external",
      url: "https://example.com/a",
    });
  });
  it("drops everything else", () => {
    for (const url of [
      "file:///Applications/Calculator.app",
      "javascript:alert(1)",
      "smb://host/share",
      "x-apple.systempreferences:",
      "data:text/html,hi",
      "not a url",
    ]) {
      expect(decideMainWindowNavigation(url, origins)).toEqual({ kind: "deny" });
    }
  });
});

describe("isAllowedWebviewUrl", () => {
  it("allows web pages and about:blank", () => {
    expect(isAllowedWebviewUrl("https://example.com")).toBe(true);
    expect(isAllowedWebviewUrl("http://localhost:3000")).toBe(true);
    expect(isAllowedWebviewUrl("about:blank")).toBe(true);
  });
  it("refuses privileged and local schemes", () => {
    for (const url of [
      "file:///etc/hosts",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "javascript:alert(1)",
      "data:text/html,x",
    ]) {
      expect(isAllowedWebviewUrl(url)).toBe(false);
    }
  });
});

describe("isGuestPermissionAllowedByDefault", () => {
  it("denies device and personal permissions", () => {
    for (const permission of ["media", "geolocation", "notifications", "display-capture", "midi"]) {
      expect(isGuestPermissionAllowedByDefault(permission)).toBe(false);
    }
    expect(isGuestPermissionAllowedByDefault("fullscreen")).toBe(true);
  });
});
