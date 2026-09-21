import { describe, expect, it } from "vitest";

import {
  buildUnoSignInUrl,
  readReturnPathFromUrl,
  recordAutoSignInAttempt,
  safeReturnPath,
  shouldAutoSignIn,
  stripReturnPathFromUrl,
  UNO_SIGN_IN_RETRY_WINDOW_MS,
} from "./unoSignIn";

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("safeReturnPath", () => {
  it("keeps same-origin paths", () => {
    expect(safeReturnPath("/")).toBe("/");
    expect(safeReturnPath("/chat/abc?x=1")).toBe("/chat/abc?x=1");
  });
  it("refuses anything that could leave the box", () => {
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "evil",
      "/a\\b",
      "/a\nb",
      "",
      null,
      undefined,
    ]) {
      expect(safeReturnPath(bad)).toBe("/");
    }
  });
  it("never returns to the pair page itself", () => {
    expect(safeReturnPath("/pair")).toBe("/");
    expect(safeReturnPath("/pair?x=1")).toBe("/");
  });
});

describe("buildUnoSignInUrl", () => {
  it("points at the console's work/open with the box and a safe return", () => {
    const url = new URL(
      buildUnoSignInUrl({ consoleUrl: "https://console.uno4.dev", boxId: 1806 }, "//evil"),
    );
    expect(url.origin).toBe("https://console.uno4.dev");
    expect(url.pathname).toBe("/work/open");
    expect(url.searchParams.get("box")).toBe("1806");
    expect(url.searchParams.get("return")).toBe("/");
  });
});

describe("return path in the pair link", () => {
  it("is read from the hash and stripped without touching the token", () => {
    const url = new URL("https://box.app.uno4.dev/pair#token=abc&return=%2Fsettings");
    expect(readReturnPathFromUrl(url)).toBe("/settings");
    const stripped = stripReturnPathFromUrl(url);
    expect(stripped.hash).toBe("#token=abc");
  });
  it("defaults to / for a hostile value", () => {
    expect(readReturnPathFromUrl(new URL("https://b/pair#return=https%3A%2F%2Fevil"))).toBe("/");
  });
});

describe("loop guard", () => {
  it("bounces once per window", () => {
    const store = memoryStore();
    expect(shouldAutoSignIn(store, 1_000)).toBe(true);
    recordAutoSignInAttempt(store, 1_000);
    expect(shouldAutoSignIn(store, 1_000 + 5_000)).toBe(false);
    expect(shouldAutoSignIn(store, 1_000 + UNO_SIGN_IN_RETRY_WINDOW_MS + 1)).toBe(true);
  });
});
