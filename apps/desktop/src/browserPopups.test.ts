import { describe, expect, it } from "vitest";

import {
  POPUP_USER_ACTIVATION_MS,
  createUserActivationTracker,
  decideGuestWindowOpen,
  popupWindowOptions,
  withoutFedCm,
} from "./browserPopups.ts";

const GOOGLE = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";

describe("decideGuestWindowOpen", () => {
  it("opens a sign-in popup (window.open with features) as a child window", () => {
    expect(decideGuestWindowOpen({ url: GOOGLE, disposition: "new-window" }, true)).toEqual({
      kind: "popup",
    });
  });

  it("keeps target=_blank and plain window.open as panel tabs", () => {
    for (const disposition of ["foreground-tab", "background-tab", "default", "other"] as const) {
      expect(decideGuestWindowOpen({ url: "https://example.com/a", disposition }, true)).toEqual({
        kind: "tab",
        url: "https://example.com/a",
      });
    }
  });

  it("blocks every new window without a recent click or key press", () => {
    for (const disposition of ["new-window", "foreground-tab", "background-tab"] as const) {
      expect(decideGuestWindowOpen({ url: GOOGLE, disposition }, false)).toEqual({
        kind: "deny",
      });
    }
  });

  it("opens only web pages", () => {
    for (const url of [
      "about:blank",
      "javascript:alert(1)",
      "data:text/html,<b>x</b>",
      "file:///etc/passwd",
      "chrome://settings",
      "zoommtg://join",
      "blob:https://example.com/1",
      "not a url",
    ]) {
      expect(decideGuestWindowOpen({ url, disposition: "new-window" }, true)).toEqual({
        kind: "deny",
      });
    }
  });

  it("does not turn a form POST into a popup", () => {
    expect(
      decideGuestWindowOpen(
        { url: "https://example.com/pay", disposition: "new-window", hasPostBody: true },
        true,
      ),
    ).toEqual({ kind: "tab", url: "https://example.com/pay" });
  });
});

describe("createUserActivationTracker", () => {
  it("counts clicks and key presses, not mouse moves or scrolls, for 5 s", () => {
    let now = 1_000;
    const tracker = createUserActivationTracker(() => now);
    expect(tracker.isActive()).toBe(false);
    tracker.onInput("mouseMove");
    tracker.onInput("mouseWheel");
    expect(tracker.isActive()).toBe(false);
    tracker.onInput("mouseDown");
    expect(tracker.isActive()).toBe(true);
    now += POPUP_USER_ACTIVATION_MS;
    expect(tracker.isActive()).toBe(true);
    now += 1;
    expect(tracker.isActive()).toBe(false);
    tracker.onInput("keyDown");
    expect(tracker.isActive()).toBe(true);
  });
});

describe("popupWindowOptions", () => {
  it("is sandboxed, isolated and without preload, Node or webviews", () => {
    expect(popupWindowOptions(null).webPreferences).not.toHaveProperty("preload");
    expect(popupWindowOptions(null).webPreferences).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
      disableBlinkFeatures: "FedCm",
    });
    expect(popupWindowOptions(null)).not.toHaveProperty("parent");
  });
});

describe("withoutFedCm", () => {
  it("adds FedCm once and keeps what was already off", () => {
    expect(withoutFedCm(undefined)).toBe("FedCm");
    expect(withoutFedCm("")).toBe("FedCm");
    expect(withoutFedCm("Foo, FedCm")).toBe("Foo,FedCm");
  });
});
