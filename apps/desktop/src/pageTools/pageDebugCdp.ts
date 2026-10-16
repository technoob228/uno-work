/**
 * Debug for a page in the panel browser, from the page's own DevTools
 * protocol (`webContents.debugger`, inside the app — never a debugging
 * port): what the Debug drawer lists.
 *
 *   - Console: `Runtime.consoleAPICalled` (log / info / warn / error, with the
 *     call's stack), `Runtime.exceptionThrown` (uncaught errors and
 *     rejections) and `Log.entryAdded` (what the browser itself says: failed
 *     resources, blocked mixed content, CSP).
 *   - Network: every request of the page — fetch, XHR, documents, scripts,
 *     styles, images — from `Network.*`, with the status, failed ones too;
 *     the answer's text for a failed fetch / XHR / page (asked for separately:
 *     `bodyFor`).
 *
 * Seen from the very start of the page: the protocol is on before the page's
 * first script, unlike anything put into the page after `dom-ready`.
 *
 * Pure: CDP events in, wire messages out (contracts/pageTools.ts).
 */
import type {
  PageToolsWireConsoleEntry,
  PageToolsWireConsoleLevel,
  PageToolsWireMessage,
  PageToolsWireNetworkEntry,
} from "@t3tools/contracts/pageTools";

const MESSAGE_MAX = 2000;
const STACK_MAX = 4000;
const BODY_MAX = 4000;
/** Requests in flight we remember; a page that never finishes them can't grow this forever. */
const MAX_PENDING_REQUESTS = 500;

export function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** The parts of a CDP `Runtime.RemoteObject` we read. */
interface RemoteObject {
  readonly type?: string;
  readonly subtype?: string;
  readonly className?: string;
  readonly value?: unknown;
  readonly unserializableValue?: string;
  readonly description?: string;
  readonly preview?: {
    readonly type?: string;
    readonly subtype?: string;
    readonly description?: string;
    readonly overflow?: boolean;
    readonly properties?: ReadonlyArray<{
      readonly name?: string;
      readonly type?: string;
      readonly value?: string;
      readonly subtype?: string;
    }>;
  };
}

interface CallFrame {
  readonly functionName?: string;
  readonly url?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

interface StackTrace {
  readonly callFrames?: ReadonlyArray<CallFrame>;
}

/** Electron's own scripts inside a page (`node:electron/js2c/…`). */
export function isElectronInternal(url: string | undefined): boolean {
  return !!url && (url.startsWith("node:electron/") || url.startsWith("electron/js2c/"));
}

function fileOf(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0] ?? url;
  return withoutQuery.split("/").pop() || withoutQuery;
}

/** `site.js:12` — the first frame of the page's own code (1-based line). */
export function sourceOfStack(stack: StackTrace | undefined): string | null {
  for (const frame of stack?.callFrames ?? []) {
    if (!frame.url) continue;
    return `${fileOf(frame.url)}:${(frame.lineNumber ?? 0) + 1}`;
  }
  return null;
}

/** Chrome's own way: `    at fn (https://…/site.js:12:5)`. */
export function formatStack(stack: StackTrace | undefined): string | null {
  const frames = (stack?.callFrames ?? []).filter((frame) => frame.url);
  if (frames.length === 0) return null;
  return frames
    .map((frame) => {
      const where = `${frame.url}:${(frame.lineNumber ?? 0) + 1}:${(frame.columnNumber ?? 0) + 1}`;
      return frame.functionName ? `    at ${frame.functionName} (${where})` : `    at ${where}`;
    })
    .join("\n");
}

function previewText(object: RemoteObject): string | null {
  const preview = object.preview;
  if (!preview?.properties) return null;
  const isArray = preview.subtype === "array";
  const parts = preview.properties.map((property) => {
    const raw = property.value ?? "";
    const value = property.type === "string" ? JSON.stringify(raw) : raw;
    return isArray ? value : `${property.name ?? "?"}: ${value}`;
  });
  if (preview.overflow) parts.push("…");
  return isArray ? `[${parts.join(", ")}]` : `{${parts.join(", ")}}`;
}

/** One console argument as Chrome's console line shows it (short). */
export function remoteObjectText(object: RemoteObject | undefined): string {
  if (!object) return "";
  switch (object.type) {
    case "string":
      return typeof object.value === "string" ? object.value : String(object.value ?? "");
    case "number":
    case "boolean":
    case "bigint":
      return object.unserializableValue ?? String(object.value);
    case "undefined":
      return "undefined";
    case "symbol":
    case "function":
      return object.description ?? object.type;
    case "object": {
      if (object.subtype === "null") return "null";
      if (object.subtype === "error")
        return (object.description ?? "Error").split("\n")[0] ?? "Error";
      return previewText(object) ?? object.description ?? object.className ?? "Object";
    }
    default:
      return object.description ?? String(object.value ?? "");
  }
}

/** `console.log("%s is %d", a, b)` — the format string the page gave, filled in. */
export function formatConsoleArgs(args: ReadonlyArray<RemoteObject>): string {
  const [first, ...rest] = args;
  if (!first) return "";
  if (first.type !== "string" || typeof first.value !== "string" || !first.value.includes("%")) {
    return args.map(remoteObjectText).join(" ");
  }
  const queue = [...rest];
  const filled = first.value.replace(/%([sdifoOc%])/g, (match, code: string) => {
    if (code === "%") return "%";
    if (queue.length === 0) return match;
    const next = queue.shift();
    if (code === "c") return ""; // CSS for the line: not text
    if (code === "d" || code === "i") {
      const number = Number(next?.value ?? next?.description);
      return Number.isFinite(number) ? String(Math.trunc(number)) : "NaN";
    }
    return remoteObjectText(next);
  });
  return [filled, ...queue.map(remoteObjectText)].join(" ");
}

const CONSOLE_LEVELS: Readonly<Record<string, PageToolsWireConsoleLevel>> = {
  log: "log",
  dir: "log",
  dirxml: "log",
  table: "log",
  trace: "log",
  info: "info",
  warning: "warn",
  error: "error",
  assert: "error",
};

const LOG_LEVELS: Readonly<Record<string, PageToolsWireConsoleLevel>> = {
  warning: "warn",
  error: "error",
};

const NETWORK_TYPES: Readonly<Record<string, PageToolsWireNetworkEntry["type"]>> = {
  Fetch: "fetch",
  XHR: "xhr",
  Image: "img",
  Script: "script",
  Stylesheet: "css",
};

interface PendingRequest {
  readonly method: string;
  readonly url: string;
  readonly type: PageToolsWireNetworkEntry["type"];
  readonly requestBody: string | null;
  readonly startedAt: number;
  status: number | null;
  statusText: string;
}

export interface PageDebugOutput {
  readonly messages: ReadonlyArray<PageToolsWireMessage>;
  /**
   * A failed fetch / XHR / page whose answer is worth reading: ask
   * `Network.getResponseBody` for `requestId`, then send `withBody(text)`.
   * Until then nothing is sent for this request.
   */
  readonly bodyFor?: {
    readonly requestId: string;
    readonly withBody: (body: string | null) => PageToolsWireMessage;
  };
}

const NOTHING: PageDebugOutput = { messages: [] };

/** One page's protocol events → Debug lines. One instance per page (webContents). */
export class PageDebugTranslator {
  private seq = 0;
  private readonly pending = new Map<string, PendingRequest>();
  /** Requests the Network domain told us about (to tell the ones it missed). */
  private readonly seen = new Set<string>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq}-${this.now().toString(36)}`;
  }

  private console(
    level: PageToolsWireConsoleLevel,
    message: string,
    stack: string | null,
    source: string | null,
  ): PageToolsWireMessage {
    const entry: PageToolsWireConsoleEntry = {
      id: this.id("c"),
      level,
      message: clip(message, MESSAGE_MAX),
      stack: stack ? clip(stack, STACK_MAX) : null,
      source,
      at: this.now(),
    };
    return { type: "console", data: entry };
  }

  /** A new page in the tab: requests of the old one won't finish here. */
  reset(): void {
    this.pending.clear();
  }

  handle(method: string, params: unknown): PageDebugOutput {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      case "Runtime.consoleAPICalled":
        return this.consoleApiCalled(p);
      case "Runtime.exceptionThrown":
        return this.exceptionThrown(p);
      case "Log.entryAdded":
        return this.logEntry(p);
      case "Network.requestWillBeSent":
        return this.requestWillBeSent(p);
      case "Network.responseReceived":
        return this.responseReceived(p);
      case "Network.loadingFinished":
        return this.loadingFinished(p);
      case "Network.loadingFailed":
        return this.loadingFailed(p);
      default:
        return NOTHING;
    }
  }

  private consoleApiCalled(p: Record<string, unknown>): PageDebugOutput {
    const level = CONSOLE_LEVELS[String(p.type)];
    if (!level) return NOTHING; // debug, groups, counters, timers: not lines
    const args = Array.isArray(p.args) ? (p.args as RemoteObject[]) : [];
    const stackTrace = p.stackTrace as StackTrace | undefined;
    // Electron's own lines in the page (its dev-only security warnings): not the site's.
    if (isElectronInternal(stackTrace?.callFrames?.[0]?.url)) return NOTHING;
    const error = args.find((arg) => arg.subtype === "error");
    const stack =
      level === "error" || level === "warn"
        ? error?.description?.includes("\n")
          ? error.description
          : formatStack(stackTrace)
        : null;
    let message = formatConsoleArgs(args);
    if (p.type === "assert") message = `Assertion failed: ${message || "console.assert"}`;
    return { messages: [this.console(level, message, stack, sourceOfStack(stackTrace))] };
  }

  private exceptionThrown(p: Record<string, unknown>): PageDebugOutput {
    const details = (p.exceptionDetails ?? {}) as {
      text?: string;
      url?: string;
      lineNumber?: number;
      exception?: RemoteObject;
      stackTrace?: StackTrace;
    };
    const exception = details.exception;
    const head = exception
      ? exception.subtype === "error"
        ? ((exception.description ?? "Error").split("\n")[0] ?? "Error")
        : remoteObjectText(exception)
      : "";
    const text = details.text?.trim() || "Uncaught";
    const message = head ? `${text} ${head}` : text;
    const stack = exception?.description?.includes("\n")
      ? exception.description
      : formatStack(details.stackTrace);
    const source =
      sourceOfStack(details.stackTrace) ??
      (details.url ? `${fileOf(details.url)}:${(details.lineNumber ?? 0) + 1}` : null);
    return { messages: [this.console("error", message, stack, source)] };
  }

  private logEntry(p: Record<string, unknown>): PageDebugOutput {
    const entry = (p.entry ?? {}) as {
      level?: string;
      text?: string;
      url?: string;
      lineNumber?: number;
      source?: string;
      networkRequestId?: string;
    };
    const level = LOG_LEVELS[String(entry.level)];
    // "violation" lines are Chrome's performance hints, not problems of the page.
    if (!level || !entry.text || entry.source === "violation") return NOTHING;
    const source = entry.url
      ? `${fileOf(entry.url)}${entry.lineNumber !== undefined ? `:${entry.lineNumber + 1}` : ""}`
      : null;
    const messages: PageToolsWireMessage[] = [this.console(level, entry.text, null, source)];
    // A failed request of a page's very first moments in a new process can
    // reach us only as the browser's own line ("Failed to load resource: …
    // status of 404"): put it in Network too.
    if (
      entry.source === "network" &&
      entry.url &&
      entry.networkRequestId &&
      !this.seen.has(entry.networkRequestId)
    ) {
      const status = /status of (\d{3})/.exec(entry.text);
      const statusText = /\(([^)]*)\)\s*$/.exec(entry.text)?.[1] ?? "";
      messages.push(
        this.networkMessage(
          {
            method: "GET",
            url: entry.url,
            type: "other",
            requestBody: null,
            startedAt: this.now(),
            status: status ? Number(status[1]) : null,
            statusText: status ? statusText : entry.text,
          },
          null,
        ),
      );
    }
    return { messages };
  }

  private requestWillBeSent(p: Record<string, unknown>): PageDebugOutput {
    const requestId = String(p.requestId ?? "");
    const request = (p.request ?? {}) as { url?: string; method?: string; postData?: string };
    const url = request.url ?? "";
    if (!requestId || !url || /^(data|blob|chrome-extension|devtools):/i.test(url)) return NOTHING;
    if (this.seen.size > 5000) this.seen.clear();
    this.seen.add(requestId);
    const messages: PageToolsWireMessage[] = [];
    // A redirect reuses the id: the hop before it is done.
    const redirect = p.redirectResponse as { status?: number; statusText?: string } | undefined;
    const previous = this.pending.get(requestId);
    if (redirect && previous) {
      previous.status = typeof redirect.status === "number" ? redirect.status : previous.status;
      previous.statusText = redirect.statusText ?? previous.statusText;
      messages.push(this.networkMessage(previous, null));
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.pending.set(requestId, {
      method: (request.method ?? "GET").toUpperCase(),
      url,
      type: NETWORK_TYPES[String(p.type)] ?? "other",
      requestBody: typeof request.postData === "string" ? clip(request.postData, BODY_MAX) : null,
      startedAt: this.now(),
      status: null,
      statusText: "",
    });
    return { messages };
  }

  private responseReceived(p: Record<string, unknown>): PageDebugOutput {
    const request = this.pending.get(String(p.requestId ?? ""));
    const response = (p.response ?? {}) as { status?: number; statusText?: string };
    if (request && typeof response.status === "number") {
      request.status = response.status;
      request.statusText = response.statusText ?? "";
    }
    return NOTHING;
  }

  private loadingFinished(p: Record<string, unknown>): PageDebugOutput {
    const requestId = String(p.requestId ?? "");
    const request = this.pending.get(requestId);
    if (!request) return NOTHING;
    this.pending.delete(requestId);
    const failed = request.status !== null && request.status >= 400;
    const readable = request.type === "fetch" || request.type === "xhr" || request.type === "other";
    if (failed && readable) {
      return {
        messages: [],
        bodyFor: {
          requestId,
          withBody: (body) =>
            this.networkMessage(request, body === null ? null : clip(body, BODY_MAX)),
        },
      };
    }
    return { messages: [this.networkMessage(request, null)] };
  }

  private loadingFailed(p: Record<string, unknown>): PageDebugOutput {
    const requestId = String(p.requestId ?? "");
    const request = this.pending.get(requestId);
    if (!request) return NOTHING;
    this.pending.delete(requestId);
    // Cancelled: the page went away or dropped it — not a failure of the site.
    if (p.canceled === true) return NOTHING;
    request.status = null;
    request.statusText =
      typeof p.blockedReason === "string" && p.blockedReason
        ? `Blocked (${p.blockedReason})`
        : String(p.errorText ?? "Failed");
    return { messages: [this.networkMessage(request, null)] };
  }

  private networkMessage(
    request: PendingRequest,
    responseBody: string | null,
  ): PageToolsWireMessage {
    const entry: PageToolsWireNetworkEntry = {
      id: this.id("n"),
      method: request.method,
      url: request.url,
      status: request.status,
      statusText:
        request.statusText || (request.status !== null && request.status < 400 ? "OK" : ""),
      type: request.type,
      durationMs: Math.max(0, this.now() - request.startedAt) || null,
      requestBody: request.requestBody,
      responseBody,
      at: this.now(),
    };
    return { type: "network", data: entry };
  }
}

/**
 * Without the protocol (attaching failed, e.g. the page's DevTools are open):
 * the guest's own `console-message` event still gives the line, without a
 * stack. Electron 41 names the levels; `info` is console.log and .info alike.
 */
export function consoleMessageFallback(
  input: {
    readonly level: string | number;
    readonly message: string;
    readonly sourceId?: string;
    readonly lineNumber?: number;
  },
  id: string,
  now: number,
): PageToolsWireMessage | null {
  const byName: Record<string, PageToolsWireConsoleLevel> = {
    info: "log",
    warning: "warn",
    error: "error",
    // "debug" (verbose): not shown, like Chrome's default console
  };
  const byNumber: Record<number, PageToolsWireConsoleLevel> = { 1: "log", 2: "warn", 3: "error" };
  const level = typeof input.level === "number" ? byNumber[input.level] : byName[input.level];
  if (!level) return null;
  return {
    type: "console",
    data: {
      id,
      level,
      message: clip(input.message, MESSAGE_MAX),
      stack: null,
      source: input.sourceId
        ? `${fileOf(input.sourceId)}${input.lineNumber ? `:${input.lineNumber}` : ""}`
        : null,
      at: now,
    },
  };
}
