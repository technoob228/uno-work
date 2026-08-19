/**
 * Page side of the Uno Work Companion extension bridge.
 *
 * In the desktop app browser commands run in an Electron webview; in the hosted
 * browser build there is no webview, so commands are relayed to the companion
 * extension, which drives the user's own tabs. Transport is `window.postMessage`
 * to the extension's content script — the page never needs the extension id.
 */

import type { BrowserAutomationCommandInput } from "@t3tools/contracts";

const PAGE_SOURCE = "uno-work-page";
const EXTENSION_SOURCE = "uno-work-extension";
const HANDSHAKE_TIMEOUT_MS = 1_500;
const COMMAND_TIMEOUT_MS = 130_000;

export interface ExtensionResponse {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

interface ExtensionMessage {
  readonly source: typeof EXTENSION_SOURCE;
  readonly type: "hello" | "result";
  readonly version?: string;
  readonly requestId?: string;
  readonly response?: ExtensionResponse;
}

function isExtensionMessage(value: unknown): value is ExtensionMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { source?: unknown }).source === EXTENSION_SOURCE
  );
}

let detectedVersion: string | null = null;
let detectionPromise: Promise<string | null> | null = null;
let requestCounter = 0;

/** Latest known extension version, or null when it has not announced itself. */
export function readDetectedExtensionVersion(): string | null {
  return detectedVersion;
}

export function resetExtensionDetectionForTests(): void {
  detectedVersion = null;
  detectionPromise = null;
}

/**
 * The content script announces itself at document_start, but the page may load
 * later, so ask once and wait briefly for a reply.
 */
export function detectBrowserExtension(): Promise<string | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (detectedVersion) return Promise.resolve(detectedVersion);
  if (detectionPromise) return detectionPromise;

  detectionPromise = new Promise<string | null>((resolve) => {
    const requestId = `detect-${(requestCounter += 1)}`;
    let settled = false;

    const finish = (version: string | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      detectedVersion = version;
      detectionPromise = null;
      resolve(version);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || !isExtensionMessage(event.data)) return;
      if (event.data.type === "hello") finish(event.data.version ?? "unknown");
    };

    window.addEventListener("message", onMessage);
    const timer = window.setTimeout(() => finish(null), HANDSHAKE_TIMEOUT_MS);
    window.postMessage({ source: PAGE_SOURCE, type: "hello", requestId }, window.location.origin);
  });

  return detectionPromise;
}

export function isBrowserExtensionConnected(): boolean {
  return detectedVersion !== null;
}

function sendToExtension(
  type: "command" | "status",
  input?: BrowserAutomationCommandInput,
): Promise<ExtensionResponse> {
  return new Promise((resolve) => {
    const requestId = `req-${(requestCounter += 1)}-${Date.now()}`;
    let settled = false;

    const finish = (response: ExtensionResponse) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      resolve(response);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window || !isExtensionMessage(event.data)) return;
      if (event.data.type !== "result" || event.data.requestId !== requestId) return;
      finish(event.data.response ?? { ok: false, error: "Empty extension response." });
    };

    window.addEventListener("message", onMessage);
    const timer = window.setTimeout(
      () => finish({ ok: false, error: "The browser extension did not respond." }),
      COMMAND_TIMEOUT_MS,
    );
    window.postMessage(
      { source: PAGE_SOURCE, type, requestId, ...(input ? { input } : {}) },
      window.location.origin,
    );
  });
}

/**
 * Runs a bridge command in the user's browser. Rejects with the extension's own
 * message on failure so the harness sees why (missing tab, blocked command…).
 */
export async function runExtensionBrowserCommand(
  input: BrowserAutomationCommandInput,
): Promise<unknown> {
  const response = await sendToExtension("command", input);
  if (!response.ok) {
    throw new Error(response.error ?? "The browser extension refused the command.");
  }
  return response.data ?? null;
}

export async function readExtensionStatus(): Promise<{ sharedTabs: number } | null> {
  const response = await sendToExtension("status");
  if (!response.ok || typeof response.data !== "object" || response.data === null) return null;
  const sharedTabs = (response.data as { sharedTabs?: unknown }).sharedTabs;
  return typeof sharedTabs === "number" ? { sharedTabs } : null;
}
