import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserAutomationCommandInput } from "@t3tools/contracts";

import {
  detectBrowserExtension,
  isBrowserExtensionConnected,
  resetExtensionDetectionForTests,
  runExtensionBrowserCommand,
} from "./browserExtensionBridge";

interface PostedMessage {
  readonly source: string;
  readonly type: string;
  readonly requestId: string;
  readonly input?: BrowserAutomationCommandInput;
}

/** Minimal stand-in for the content script running on the page. */
function installFakeExtension(options: { respond: (message: PostedMessage) => unknown | null }) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const posted: PostedMessage[] = [];

  const deliver = (data: unknown) => {
    const event = { source: fakeWindow, data } as unknown as MessageEvent;
    for (const listener of [...listeners]) listener(event);
  };

  const fakeWindow = {
    location: { origin: "https://work.uno4.dev" },
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
      listeners.delete(listener);
    },
    postMessage: (data: PostedMessage) => {
      posted.push(data);
      const response = options.respond(data);
      if (response !== null) queueMicrotask(() => deliver(response));
    },
    setTimeout: ((handler: () => void, ms: number) =>
      globalThis.setTimeout(handler, ms)) as typeof window.setTimeout,
    clearTimeout: ((id: number) => globalThis.clearTimeout(id)) as typeof window.clearTimeout,
  };

  vi.stubGlobal("window", fakeWindow);
  return { posted, deliver };
}

beforeEach(() => {
  resetExtensionDetectionForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetExtensionDetectionForTests();
});

describe("detectBrowserExtension", () => {
  it("resolves with the announced version", async () => {
    installFakeExtension({
      respond: (message) =>
        message.type === "hello"
          ? { source: "uno-work-extension", type: "hello", version: "0.1.0" }
          : null,
    });

    await expect(detectBrowserExtension()).resolves.toBe("0.1.0");
    expect(isBrowserExtensionConnected()).toBe(true);
  });

  it("resolves null when nothing answers", async () => {
    vi.useFakeTimers();
    installFakeExtension({ respond: () => null });

    const detection = detectBrowserExtension();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(detection).resolves.toBeNull();
    expect(isBrowserExtensionConnected()).toBe(false);
    vi.useRealTimers();
  });
});

describe("runExtensionBrowserCommand", () => {
  it("returns the command payload", async () => {
    installFakeExtension({
      respond: (message) =>
        message.type === "command"
          ? {
              source: "uno-work-extension",
              type: "result",
              requestId: message.requestId,
              response: { ok: true, data: { url: "https://example.com" } },
            }
          : null,
    });

    await expect(runExtensionBrowserCommand({ command: "state" })).resolves.toEqual({
      url: "https://example.com",
    });
  });

  it("surfaces the extension's own error message", async () => {
    installFakeExtension({
      respond: (message) => ({
        source: "uno-work-extension",
        type: "result",
        requestId: message.requestId,
        response: { ok: false, error: "No shared tab." },
      }),
    });

    await expect(runExtensionBrowserCommand({ command: "click", selector: "#a" })).rejects.toThrow(
      "No shared tab.",
    );
  });

  it("ignores replies meant for another request", async () => {
    vi.useFakeTimers();
    installFakeExtension({
      respond: (message) => ({
        source: "uno-work-extension",
        type: "result",
        requestId: `${message.requestId}-other`,
        response: { ok: true, data: "nope" },
      }),
    });

    const pending = runExtensionBrowserCommand({ command: "state" });
    const assertion = expect(pending).rejects.toThrow("did not respond");
    await vi.advanceTimersByTimeAsync(140_000);
    await assertion;
    vi.useRealTimers();
  });
});
