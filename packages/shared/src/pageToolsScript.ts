/**
 * The script the panel's browser puts into every page it shows (w0138):
 * Comment and Debug live inside the page, like react-grab in upstream t3's
 * annotate and Codex desktop's comment mode.
 *
 *   - Debug: the page's console (error / warn / info / log, uncaught errors,
 *     unhandled rejections) and its network (fetch, XHR and every resource
 *     the page loaded, with the status — failed ones too).
 *   - Comment: a crosshair; hovering highlights an element with its name;
 *     a click picks it, Shift+drag picks an area; numbered pins stay on the
 *     page. The note itself is typed in the app (the host), not in the page.
 *
 * One channel back to the host for both browsers: `console.debug(nonce +
 * json)` — the desktop <webview> reports it as `console-message`, the demo's
 * iframe adapter (iframeWebview.ts) does the same. The host calls in with
 * `executeJavaScript("window.__unoPageTools.…")`. Plain ES2017 in a string:
 * it runs inside someone else's page, so nothing of the app's bundle.
 *
 * Installed on each new document (`dom-ready`); what the page logged before
 * that is lost — except resources, which the performance timeline keeps.
 * A desktop preload (upstream's PickPreload) would see the very start too.
 *
 * The computer's own browser (the agent's, a live picture in the panel —
 * liveWebview.ts) has no console channel to the app: there the script runs
 * with `channel: "queue"` — messages wait in the page until the app drains
 * them (`drain()`), and the pointer is the app's, not the page's: the
 * person's moves and clicks over the picture come as `hoverAt` / `pickAt` /
 * `dragAt` / `areaAt`. The page's own events (the agent's clicks) are never
 * blocked there.
 *
 * "Your site" from a cloud computer in the web's iframe (18.10) is another
 * origin — no `executeJavaScript`, no console. There the daemon puts the
 * script into the page itself (`/__uno/page-tools.js`, channel
 * `postMessage`): lines go to `window.parent` as `{ __unoPageTools: true,
 * line }`, the host's calls come back as `message` events from the parent
 * (`{ __unoPageTools: true, method, arg }`), the first being `setNonce`;
 * until then lines wait in the page. Outside a frame (and in a <webview>,
 * which is a top window) the script does nothing.
 *
 * Who the page talks to (19.10) — never `"*"`, never "any *.uno4.work": the
 * page's console, its fetch/XHR bodies and the person's picks go to one
 * exact origin, and only that origin's calls count.
 *
 *   - A port's page (`p5173--abc.uno4.work`, served by the daemon): Work at
 *     `https://abc.uno4.work`, read from the page's own host.
 *   - The person's own site on Uno Sites (`*.uno4.me` or its own domain,
 *     served by the console with `verifyPath`): nobody, until the parent's
 *     `setNonce` comes with a token (`{ method: "setNonce", arg, token }`)
 *     that the site's own server confirms for exactly that parent origin
 *     (`POST verifyPath` `{ token, parentOrigin }` → `{ ok: true }`). Only the
 *     site's owner gets such a token, for their own Work address. Until then
 *     nothing leaves the page — not even its address; the parent's other
 *     calls from that origin wait and are applied after.
 */

export const PAGE_TOOLS_GLOBAL = "__unoPageTools";

export type PageToolsMessage =
  | { readonly type: "ready"; readonly data: { readonly url: string; readonly title: string } }
  | { readonly type: "console"; readonly data: unknown }
  | { readonly type: "network"; readonly data: unknown }
  | { readonly type: "pick"; readonly data: PagePick }
  | { readonly type: "pinClick"; readonly data: { readonly n: number } }
  | { readonly type: "selection"; readonly data: PageSelection }
  | { readonly type: "key"; readonly data: { readonly key: string } };

/** What the person selected on the page; empty text: nothing any more. */
export interface PageSelection {
  readonly text: string;
  readonly url: string;
  /** The selection's last line in the page's viewport (CSS pixels). */
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

const SELECTION_MAX_TEXT = 8_000;

/**
 * Reads the selection in a page: plain ES2017, for the in-page script and for
 * the computer's live browser, which asks once after the person's mouse up. A
 * selection inside a field is the field's, and may be a password: not reported.
 */
const READ_SELECTION = `function () {
    var s = window.getSelection ? window.getSelection() : null;
    var a = document.activeElement;
    var field = a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName || ""));
    var text = s && !s.isCollapsed && s.rangeCount && !field ? String(s).trim() : "";
    var box = { x: 0, y: 0, w: 0, h: 0 };
    if (text) {
      var range = s.getRangeAt(0), lines = range.getClientRects();
      var last = lines.length ? lines[lines.length - 1] : range.getBoundingClientRect();
      box = { x: last.left, y: last.top, w: last.width, h: last.height };
    }
    return { text: text.slice(0, ${SELECTION_MAX_TEXT}), url: location.href, rect: box };
  }`;

/** One evaluation in a page: its {@link PageSelection}. */
export const PAGE_SELECTION_EXPRESSION = `(${READ_SELECTION})()`;

/** A selection as the page reported it, checked (a page can say anything); null: none. */
export function pageSelectionFrom(data: unknown): PageSelection | null {
  const { text, url, rect } = (data ?? {}) as Partial<PageSelection>;
  if (typeof text !== "string" || text.length === 0 || typeof url !== "string") return null;
  const { x, y, w, h } = (rect ?? {}) as Partial<PageSelection["rect"]>;
  if (![x, y, w, h].every((value) => typeof value === "number" && Number.isFinite(value))) {
    return null;
  }
  return {
    text: text.slice(0, SELECTION_MAX_TEXT),
    url: url.slice(0, 2_000),
    rect: { x: x as number, y: y as number, w: w as number, h: h as number },
  };
}

export interface PagePick {
  readonly kind: "element" | "area";
  readonly selector: string | null;
  readonly label: string;
  readonly text: string | null;
  /** In the page's viewport (CSS pixels): where the host puts the note box. */
  readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly docRect: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
}

/** A pin the page draws (the host owns the list). */
export interface PagePin {
  readonly n: number;
  readonly kind: "element" | "area";
  readonly selector: string | null;
  readonly docRect: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
}

/** Parse one console line of the page: ours (with this nonce) or null. */
export function parsePageToolsMessage(nonce: string, message: unknown): PageToolsMessage | null {
  if (typeof message !== "string" || !message.startsWith(nonce)) return null;
  try {
    const parsed = JSON.parse(message.slice(nonce.length)) as { type?: unknown; data?: unknown };
    if (typeof parsed.type !== "string") return null;
    return parsed as PageToolsMessage;
  } catch {
    return null;
  }
}

/**
 * How the script talks back: console lines (a <webview>, the demo's iframe),
 * a queue the app drains (the computer's live browser) or messages to the
 * parent window (a port's page in the web's iframe).
 */
export type PageToolsChannel = "console" | "queue" | "postMessage";

/** Marks our messages between a port's page and the host (postMessage channel). */
export const PAGE_TOOLS_MESSAGE_KEY = "__unoPageTools";

/**
 * Where a site's page asks its own server whether the parent's token is good
 * (the console serves the script and this on the person's Uno Sites hosts).
 */
export const SITE_PAGE_TOOLS_VERIFY_PATH = "/__uno/page-tools/verify";

/** What the host tells the page over the postMessage channel. */
export type PageToolsPostCommand =
  /** `token`: a site's page talks only to a parent whose token its server confirmed. */
  | { readonly method: "setNonce"; readonly arg: string; readonly token?: string }
  | { readonly method: "setMode"; readonly arg: "comment" | "off" }
  | { readonly method: "setPins"; readonly arg: ReadonlyArray<PagePin> }
  | { readonly method: "setPaused"; readonly arg: boolean };

/** What a port's page posts to the host: a line (as on the console channel) or where it is. */
export type PageToolsPostEvent =
  | { readonly kind: "line"; readonly line: string }
  | { readonly kind: "nav"; readonly url: string; readonly title: string };

/** One `message` event's data from the page: ours, or null. */
export function parsePageToolsPostEvent(data: unknown): PageToolsPostEvent | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record[PAGE_TOOLS_MESSAGE_KEY] !== true) return null;
  if (typeof record["line"] === "string") return { kind: "line", line: record["line"] };
  const nav = record["nav"];
  if (nav && typeof nav === "object") {
    const { url, title } = nav as { url?: unknown; title?: unknown };
    if (typeof url === "string") {
      return { kind: "nav", url, title: typeof title === "string" ? title : "" };
    }
  }
  return null;
}

/** The message the host posts into a port's page. */
export function pageToolsPostMessage(command: PageToolsPostCommand): Record<string, unknown> {
  const message: Record<string, unknown> = {
    [PAGE_TOOLS_MESSAGE_KEY]: true,
    method: command.method,
    arg: command.arg,
  };
  if (command.method === "setNonce" && command.token !== undefined)
    message["token"] = command.token;
  return message;
}

/** The person's pointer over a live picture, in the page's CSS pixels. */
export type PageToolsPointerMethod = "hoverAt" | "pickAt" | "dragAt" | "areaAt";

/** A pointer call into the installed script (queue channel); harmless without it. */
export function pageToolsPointerCall(
  method: PageToolsPointerMethod,
  coords: ReadonlyArray<number>,
): string {
  const args = coords.map((value) => (Number.isFinite(value) ? Math.round(value) : 0)).join(",");
  return `(function(t){ if (t && t.${method}) t.${method}(${args}); return true; })(window.${PAGE_TOOLS_GLOBAL})`;
}

/**
 * Take what the page queued (queue channel): the lines, or null when the
 * script isn't in this document (a new page: put it in again).
 */
export const PAGE_TOOLS_DRAIN_EXPRESSION = `(function(t){ return t && t.doc === document && t.drain ? t.drain() : null; })(window.${PAGE_TOOLS_GLOBAL})`;

/** A call into the installed script; harmless on a page that doesn't have it (yet). */
export function pageToolsCall(method: "setMode" | "setPins" | "setPaused", arg: unknown): string {
  return `(function(t){ if (t) t.${method}(${JSON.stringify(arg)}); return true; })(window.${PAGE_TOOLS_GLOBAL})`;
}

const SCRIPT = String.raw`
(function (NONCE, QUEUE, POST, VERIFY) {
  var w = window;
  var G = "${PAGE_TOOLS_GLOBAL}";
  var M = "${PAGE_TOOLS_MESSAGE_KEY}";
  // The postMessage channel lives only in a frame: anywhere else the page is
  // left exactly as it is.
  if (POST && w.parent === w) return "standalone";
  // The one origin the page talks to (postMessage channel); null — nobody yet.
  // A port's address p5173--abc.uno4.work: Work at abc.uno4.work exactly. A
  // site (VERIFY): the parent whose token the site's server confirms.
  var PARENT = null;
  if (POST && !VERIFY) {
    var ph = /^p\d+--([a-z0-9-]+)\.([a-z0-9.-]+)$/i.exec(location.hostname);
    if (!ph) return "no-parent";
    PARENT = location.protocol + "//" + ph[1].toLowerCase() + "." + ph[2].toLowerCase() + (location.port ? ":" + location.port : "");
  }
  if (w[G] && w[G].doc === document) {
    if (!QUEUE && w[G].nonce === NONCE) return "already";
    // The queue channel: one script per page whoever drains it (a new view of
    // the same page just takes the channel over).
    if (QUEUE && w[G].drain) { w[G].setNonce(NONCE); return "already"; }
  }
  var origDebug = console.debug.bind(console);
  var Q = [];
  function emit(type, data) {
    try {
      var line = NONCE + JSON.stringify({ type: type, data: data });
      if (QUEUE || (POST && (!NONCE || !PARENT))) { Q.push(line); if (Q.length > 400) Q.splice(0, Q.length - 400); }
      else if (POST) post({ line: line });
      else origDebug(line);
    } catch (e) {}
  }
  function post(data) {
    if (!PARENT) return;
    try { data[M] = true; w.parent.postMessage(data, PARENT); } catch (e) {}
  }
  var seq = 0;
  function nid() { seq += 1; return "p" + seq + "-" + Date.now().toString(36); }
  function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + "…" : s; }

  // ── Debug: console ──────────────────────────────────────────────────
  function str(v) {
    if (v instanceof Error) return (v.name || "Error") + ": " + v.message;
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  function sourceOf(stack) {
    if (!stack) return null;
    var lines = String(stack).split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf("eval") >= 0 || line.indexOf("<anonymous>") >= 0) continue;
      var m = line.match(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/);
      if (m) return m[1].split("/").pop().split("?")[0] + ":" + m[2];
    }
    return null;
  }
  function pageStack(stack) {
    if (!stack) return null;
    return String(stack).split("\n").filter(function (line) {
      return line.indexOf("eval") < 0 && line.indexOf("<anonymous>") < 0;
    }).join("\n");
  }
  ["error", "warn", "info", "log"].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      try {
        var err = null;
        for (var i = 0; i < args.length; i++) if (args[i] instanceof Error) { err = args[i]; break; }
        var here = new Error().stack;
        emit("console", {
          id: nid(), level: level, at: Date.now(),
          message: clip(args.map(str).join(" "), 2000),
          stack: err ? clip(pageStack(err.stack), 4000) : null,
          source: sourceOf(err ? err.stack : here)
        });
      } catch (e) {}
      return orig.apply(this, args);
    };
  });
  w.addEventListener("error", function (e) {
    if (e.target && e.target !== w) return; // resources: the performance timeline below
    var err = e.error;
    emit("console", {
      id: nid(), level: "error", at: Date.now(),
      message: clip("Uncaught " + (err ? str(err) : e.message), 2000),
      stack: err && err.stack ? clip(pageStack(err.stack), 4000) : null,
      source: e.filename ? e.filename.split("/").pop().split("?")[0] + ":" + e.lineno : sourceOf(err && err.stack)
    });
  }, true);
  w.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    emit("console", {
      id: nid(), level: "error", at: Date.now(),
      message: clip("Uncaught (in promise) " + str(r), 2000),
      stack: r && r.stack ? clip(pageStack(r.stack), 4000) : null,
      source: sourceOf(r && r.stack)
    });
  });

  // ── Debug: network ──────────────────────────────────────────────────
  function abs(u) { try { return new URL(u, location.href).href; } catch (e) { return String(u); } }
  function bodyText(b) {
    if (b == null) return null;
    if (typeof b === "string") return clip(b, 4000);
    if (b instanceof URLSearchParams) return clip(b.toString(), 4000);
    if (typeof FormData !== "undefined" && b instanceof FormData) {
      var o = {}; b.forEach(function (v, k) { o[k] = typeof v === "string" ? v : "(file)"; });
      return clip(JSON.stringify(o), 4000);
    }
    return "(binary)";
  }
  var origFetch = w.fetch;
  if (origFetch) {
    w.fetch = function (input, init) {
      var started = performance.now();
      var url = abs(typeof input === "string" || input instanceof URL ? String(input) : input.url);
      var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
      var entry = { id: nid(), method: method, url: url, type: "fetch", at: Date.now(),
        requestBody: bodyText(init && init.body), responseBody: null, status: null, statusText: "", durationMs: null };
      return origFetch.apply(this, arguments).then(function (res) {
        entry.status = res.status; entry.statusText = res.statusText || "";
        entry.durationMs = performance.now() - started;
        if (!res.ok) {
          res.clone().text().then(function (t) { entry.responseBody = clip(t, 4000); emit("network", entry); },
            function () { emit("network", entry); });
        } else emit("network", entry);
        return res;
      }, function (err) {
        entry.statusText = str(err); entry.durationMs = performance.now() - started;
        emit("network", entry);
        throw err;
      });
    };
  }
  var XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__uno = { method: String(method || "GET").toUpperCase(), url: abs(url) };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this, meta = xhr.__uno, started = performance.now();
    if (meta) {
      xhr.addEventListener("loadend", function () {
        var failed = xhr.status === 0;
        emit("network", { id: nid(), method: meta.method, url: meta.url, type: "xhr", at: Date.now(),
          status: failed ? null : xhr.status, statusText: failed ? "Failed" : (xhr.statusText || ""),
          durationMs: performance.now() - started, requestBody: bodyText(body),
          responseBody: !failed && xhr.status >= 400 && (xhr.responseType === "" || xhr.responseType === "text") ? clip(xhr.responseText, 4000) : null });
      });
    }
    return XS.apply(this, arguments);
  };
  var TYPES = { img: "img", image: "img", script: "script", link: "css", css: "css" };
  function resource(entry) {
    if (entry.initiatorType === "fetch" || entry.initiatorType === "xmlhttprequest") return;
    var status = typeof entry.responseStatus === "number" && entry.responseStatus > 0 ? entry.responseStatus : 200;
    var type = TYPES[entry.initiatorType] || "other";
    emit("network", { id: nid(), method: "GET", url: entry.name, type: type, at: Date.now(),
      status: status, statusText: status >= 400 ? (status === 404 ? "Not Found" : "") : "OK",
      durationMs: entry.duration, requestBody: null, responseBody: null });
    if (status >= 400) {
      emit("console", { id: nid(), level: "error", at: Date.now(), stack: null,
        message: "Failed to load resource: the server responded with a status of " + status + " (" + entry.name.split("/").pop() + ")",
        source: entry.name.split("/").pop().split("?")[0] });
    }
  }

  // ── Comment ─────────────────────────────────────────────────────────
  var mode = "off", paused = false, pins = [], dragging = null, current = null;
  var host = null, root = null, hl = null, hlLabel = null, areaBox = null, pinsLayer = null, styleEl = null;
  var ACCENT = "#5b5bd6";
  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement("uno-page-tools");
    host.setAttribute("style", "position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block;");
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<style>" +
      ".hl{position:fixed;display:none;border:1.5px solid " + ACCENT + ";background:rgba(91,91,214,.08);border-radius:4px;pointer-events:none;box-sizing:border-box}" +
      ".hl.pending{background:rgba(91,91,214,.14);border-width:2px}" +
      ".lbl{position:absolute;left:-1.5px;bottom:100%;margin-bottom:3px;background:" + ACCENT + ";color:#fff;font:500 11px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:3px 6px;border-radius:4px;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}" +
      ".lbl.below{bottom:auto;top:100%;margin:3px 0 0}" +
      ".lbl i{font-style:normal;opacity:.75;margin-left:6px}" +
      ".area{position:fixed;display:none;border:1.5px dashed " + ACCENT + ";background:rgba(91,91,214,.08);border-radius:4px;box-sizing:border-box}" +
      ".pin{position:fixed;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:" + ACCENT + ";color:#fff;font:600 11px/20px ui-sans-serif,system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff,0 1px 4px rgba(0,0,0,.35);pointer-events:auto;cursor:pointer}" +
      ".mark{position:fixed;border:1.5px solid rgba(91,91,214,.55);border-radius:4px;box-sizing:border-box}" +
      ".mark.area{display:block;border-style:dashed}" +
      "</style><div class='pins'></div><div class='hl'><span class='lbl'></span></div><div class='area'></div>";
    hl = root.querySelector(".hl"); hlLabel = root.querySelector(".lbl");
    areaBox = root.querySelector(".area"); pinsLayer = root.querySelector(".pins");
    document.documentElement.appendChild(host);
  }
  function setCursor(on) {
    if (on && !styleEl) {
      styleEl = document.createElement("style");
      styleEl.textContent = "html.__uno-commenting, html.__uno-commenting * { cursor: crosshair !important; }";
      (document.head || document.documentElement).appendChild(styleEl);
    }
    document.documentElement.classList.toggle("__uno-commenting", on);
  }
  function esc(s) { return w.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }
  function classesOf(el) {
    return Array.prototype.filter.call(el.classList, function (c) {
      return c.indexOf("__uno") !== 0 && c.length < 32 && !/^(is|has)-/.test(c) && !/\d{4,}/.test(c);
    }).slice(0, 2);
  }
  function partOf(el) {
    var tag = el.tagName.toLowerCase();
    if (el.id && !/\d{3,}/.test(el.id)) return "#" + esc(el.id);
    var s = tag + classesOf(el).map(function (c) { return "." + esc(c); }).join("");
    var parent = el.parentElement;
    if (parent) {
      var sameTag = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === el.tagName; });
      var sameSel = sameTag.filter(function (c) { try { return c.matches(s); } catch (e) { return false; } });
      if (sameSel.length > 1) s += ":nth-of-type(" + (sameTag.indexOf(el) + 1) + ")";
    }
    return s;
  }
  function selectorOf(el) {
    var parts = [], cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 6) {
      var p = partOf(cur);
      parts.unshift(p);
      var sel = parts.join(" > ");
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch (e) {}
      if (p.charAt(0) === "#") break;
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }
  function labelOf(el) {
    var tag = el.tagName.toLowerCase();
    var cls = classesOf(el);
    return el.id ? tag + "#" + el.id : tag + (cls.length ? "." + cls[0] : "");
  }
  function textOf(el) {
    var t = "";
    if (el.tagName === "IMG") t = el.getAttribute("alt") || el.getAttribute("src") || "";
    else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") t = el.getAttribute("placeholder") || el.value || "";
    else t = (el.innerText || el.textContent || "");
    t = t.replace(/\s+/g, " ").trim();
    return t ? clip(t, 80) : null;
  }
  function rectOf(r) { return { x: r.left, y: r.top, w: r.width, h: r.height }; }
  function docRectOf(r) { return { x: r.left + w.scrollX, y: r.top + w.scrollY, w: r.width, h: r.height }; }
  function place(box, r) {
    box.style.display = "block";
    box.style.left = r.left + "px"; box.style.top = r.top + "px";
    box.style.width = r.width + "px"; box.style.height = r.height + "px";
  }
  function targetAt(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el || el === host || el === document.documentElement || el === document.body) return null;
    return el;
  }
  function showHighlight(el) {
    ensureHost();
    current = el;
    if (!el) { hl.style.display = "none"; return; }
    var r = el.getBoundingClientRect();
    place(hl, r);
    hlLabel.className = r.top < 24 ? "lbl below" : "lbl";
    hlLabel.innerHTML = "";
    hlLabel.appendChild(document.createTextNode(labelOf(el)));
    var size = document.createElement("i");
    size.textContent = Math.round(r.width) + "×" + Math.round(r.height);
    hlLabel.appendChild(size);
  }
  function inPin(e) {
    var path = e.composedPath ? e.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (node && node.classList && node.classList.contains("pin")) return node;
    }
    return null;
  }
  function block(e) { e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); }
  function onMove(e) {
    if (mode !== "comment" || paused) return;
    if (dragging) {
      var x = Math.min(dragging.x, e.clientX), y = Math.min(dragging.y, e.clientY);
      var r = { left: x, top: y, width: Math.abs(e.clientX - dragging.x), height: Math.abs(e.clientY - dragging.y) };
      dragging.rect = r;
      place(areaBox, r);
      hl.style.display = "none";
      return;
    }
    showHighlight(targetAt(e.clientX, e.clientY));
  }
  function onDown(e) {
    if (mode !== "comment") return;
    var pin = inPin(e);
    block(e);
    if (paused) return;
    if (pin) { emit("pinClick", { n: Number(pin.getAttribute("data-n")) }); return; }
    if (e.shiftKey) { ensureHost(); dragging = { x: e.clientX, y: e.clientY, rect: null }; }
  }
  function pickArea(rect) {
    if (rect && rect.width > 8 && rect.height > 8) {
      var inside = [];
      var all = document.body ? document.body.querySelectorAll("h1,h2,h3,h4,p,a,button,img,input,label,li") : [];
      for (var i = 0; i < all.length && inside.length < 4; i++) {
        var b = all[i].getBoundingClientRect();
        if (b.width && b.left >= rect.left && b.top >= rect.top && b.right <= rect.left + rect.width && b.bottom <= rect.top + rect.height) inside.push(labelOf(all[i]));
      }
      paused = true;
      emit("pick", { kind: "area", selector: null,
        label: "Area " + Math.round(rect.width) + "×" + Math.round(rect.height),
        text: inside.length ? inside.join(", ") : null,
        rect: rectOf(rect), docRect: docRectOf(rect) });
    } else areaBox.style.display = "none";
  }
  function pickElement(el) {
    var r = el.getBoundingClientRect();
    paused = true;
    hl.classList.add("pending");
    emit("pick", { kind: "element", selector: selectorOf(el), label: labelOf(el), text: textOf(el),
      rect: rectOf(r), docRect: docRectOf(r) });
  }
  function onUp(e) {
    if (mode !== "comment") return;
    block(e);
    if (paused) return;
    if (dragging) {
      var d = dragging; dragging = null;
      pickArea(d.rect);
      return;
    }
  }
  function onClick(e) {
    if (mode !== "comment") return;
    block(e);
    if (paused || inPin(e)) return;
    var el = current || targetAt(e.clientX, e.clientY);
    if (!el) return;
    pickElement(el);
  }
  // The queue channel: the pointer is the app's (a picture of the page), and
  // the page's own events — the agent's clicks — stay the page's.
  if (!QUEUE) {
  // Text selected on the page: the app offers a quote over it.
  var readSelection = __READ_SELECTION__;
  var selTimer = 0, selDown = false, selLast = "";
  function selReport() {
    selTimer = 0;
    if (selDown) return;
    var sel = mode === "off" ? readSelection() : { text: "", url: location.href, rect: { x: 0, y: 0, w: 0, h: 0 } };
    var key = sel.text ? sel.text + "|" + Math.round(sel.rect.x) + "|" + Math.round(sel.rect.y) : "";
    if (key === selLast) return;
    selLast = key;
    emit("selection", sel);
  }
  function selSoon() { if (!selTimer) selTimer = setTimeout(selReport, 120); }
  document.addEventListener("selectionchange", selSoon);
  w.addEventListener("pointerdown", function () { selDown = true; }, true);
  w.addEventListener("pointerup", function () { selDown = false; selSoon(); }, true);
  w.addEventListener("scroll", function () { if (selLast) selSoon(); }, true);
  ["pointerdown", "mousedown"].forEach(function (t) { w.addEventListener(t, onDown, true); });
  ["pointerup", "mouseup"].forEach(function (t) { w.addEventListener(t, onUp, true); });
  ["click", "dblclick", "auxclick", "contextmenu"].forEach(function (t) { w.addEventListener(t, onClick, true); });
  w.addEventListener("pointermove", onMove, true);
  w.addEventListener("keydown", function (e) {
    var t = e.target;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ""));
    if (typing && e.key !== "Escape") return;
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === "c" || k === "Escape") {
      if (mode === "comment") block(e);
      emit("key", { key: k });
    }
  }, true);
  }
  function boxOf(x0, y0, x1, y1) {
    return { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  }
  function pinAt(x, y) {
    if (!pinsLayer) return null;
    var list = pinsLayer.querySelectorAll(".pin");
    for (var i = 0; i < list.length; i++) {
      var b = list[i].getBoundingClientRect();
      if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return list[i];
    }
    return null;
  }

  // The part of an element's box that is really on screen: not off the
  // viewport, not under a sticky header (or anything else drawn on top).
  function visibleRect(el, r) {
    var top = Math.max(r.top, 0), bottom = Math.min(r.bottom, w.innerHeight);
    if (bottom - top < 4 || r.right < 0 || r.left > w.innerWidth) return null;
    var x = Math.min(Math.max(r.left + r.width / 2, 1), w.innerWidth - 1);
    for (var guard = 0; guard < 4; guard++) {
      var hit = document.elementFromPoint(x, top + 1);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el) || hit === host) break;
      var cover = hit.getBoundingClientRect();
      if (cover.bottom >= bottom - 2) return null;
      top = Math.max(top, cover.bottom);
    }
    return { left: r.left, top: top, width: r.width, height: bottom - top };
  }
  function drawPins() {
    if (!pinsLayer) return;
    pinsLayer.innerHTML = "";
    pinsLayer.style.display = "none";
    var shown = [];
    for (var i = 0; i < pins.length; i++) {
      var p = pins[i], r = null, el = null;
      if (p.kind === "element" && p.selector) {
        try { el = document.querySelector(p.selector); } catch (e) {}
      }
      if (el) r = visibleRect(el, el.getBoundingClientRect());
      else {
        var a = { left: p.docRect.x - w.scrollX, top: p.docRect.y - w.scrollY, width: p.docRect.w, height: p.docRect.h };
        var top = Math.max(a.top, 0), bottom = Math.min(a.top + a.height, w.innerHeight);
        r = bottom - top >= 4 ? { left: a.left, top: top, width: a.width, height: bottom - top } : null;
      }
      if (r) shown.push({ p: p, r: r });
    }
    pinsLayer.style.display = "";
    for (var j = 0; j < shown.length; j++) {
      var item = shown[j];
      var mark = document.createElement("div");
      mark.className = item.p.kind === "area" ? "mark area" : "mark";
      place(mark, item.r);
      pinsLayer.appendChild(mark);
      var pin = document.createElement("div");
      pin.className = "pin";
      pin.setAttribute("data-n", String(item.p.n));
      pin.textContent = String(item.p.n);
      pin.style.left = Math.min(Math.max(item.r.left + item.r.width, 12), w.innerWidth - 12) + "px";
      pin.style.top = Math.min(Math.max(item.r.top, 12), w.innerHeight - 12) + "px";
      pinsLayer.appendChild(pin);
    }
  }
  var raf = 0;
  function redraw() {
    if (raf) return;
    raf = requestAnimationFrame(function () {
      raf = 0; drawPins();
      if (paused && current && hl && hl.style.display !== "none") showHighlight(current);
    });
  }
  w.addEventListener("scroll", redraw, true);
  w.addEventListener("resize", redraw);

  w[G] = {
    nonce: NONCE,
    doc: document,
    setMode: function (m) {
      mode = m === "comment" ? "comment" : "off";
      setCursor(mode === "comment");
      ensureHost();
      if (mode !== "comment") { hl.style.display = "none"; areaBox.style.display = "none"; paused = false; dragging = null; }
    },
    setPins: function (list) { ensureHost(); pins = Array.isArray(list) ? list : []; drawPins(); },
    setPaused: function (on) {
      paused = !!on;
      if (!paused) { ensureHost(); hl.classList.remove("pending"); hl.style.display = "none"; areaBox.style.display = "none"; current = null; }
    },
    drain: QUEUE ? function () { var out = Q; Q = []; return out; } : undefined,
    // A new view of the page takes the channel over: what waits in the queue is its now.
    setNonce: function (n) {
      var old = NONCE;
      Q = Q.map(function (line) { return line.indexOf(old) === 0 ? n + line.slice(old.length) : line; });
      NONCE = n; w[G].nonce = n;
      // The host is listening now: what the page said before goes first.
      if (POST && n && PARENT) { var out = Q; Q = []; out.forEach(function (line) { post({ line: line }); }); }
    },
    hoverAt: function (x, y) {
      if (mode !== "comment" || paused) return;
      showHighlight(targetAt(x, y));
    },
    pickAt: function (x, y) {
      if (mode !== "comment" || paused) return;
      var pin = pinAt(x, y);
      if (pin) { emit("pinClick", { n: Number(pin.getAttribute("data-n")) }); return; }
      var el = targetAt(x, y);
      if (!el) return;
      showHighlight(el);
      pickElement(el);
    },
    dragAt: function (x0, y0, x1, y1) {
      if (mode !== "comment" || paused) return;
      ensureHost();
      place(areaBox, boxOf(x0, y0, x1, y1));
      hl.style.display = "none";
    },
    areaAt: function (x0, y0, x1, y1) {
      if (mode !== "comment" || paused) return;
      ensureHost();
      pickArea(boxOf(x0, y0, x1, y1));
    }
  };

  if (POST) {
    // The host can't read another origin's address: the page tells it, on
    // every load and every in-page move (history, hash).
    var reportNav = function () { post({ nav: { url: location.href, title: document.title } }); };
    ["pushState", "replaceState"].forEach(function (k) {
      var orig = history[k];
      if (typeof orig !== "function") return;
      history[k] = function () { var r = orig.apply(this, arguments); reportNav(); return r; };
    });
    w.addEventListener("popstate", reportNav);
    w.addEventListener("hashchange", reportNav);
    w.addEventListener("load", reportNav);
    reportNav();
    var apply = function (d) {
      var t = w[G];
      if (d.method === "setNonce" && typeof d.arg === "string") t.setNonce(d.arg);
      else if (d.method === "setMode" || d.method === "setPins" || d.method === "setPaused") t[d.method](d.arg);
    };
    // A site: the parent's token goes to the site's own server with the
    // parent's origin; only its "ok" makes that origin the page's parent.
    var verifying = null, held = [];
    var verify = function (origin, d) {
      if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) || typeof origFetch !== "function") return;
      verifying = origin;
      var done = function (ok) {
        var later = held;
        held = []; verifying = null;
        if (!ok || PARENT) return;
        PARENT = origin;
        reportNav();
        apply(d);
        later.forEach(apply);
      };
      try {
        origFetch.call(w, VERIFY, {
          method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: d.token, parentOrigin: origin })
        }).then(function (res) { return res.ok ? res.json() : null; })
          .then(function (j) { done(!!(j && j.ok === true)); }, function () { done(false); });
      } catch (err) { done(false); }
    };
    w.addEventListener("message", function (e) {
      if (e.source !== w.parent) return;
      var d = e.data;
      if (!d || d[M] !== true || typeof d.method !== "string") return;
      if (PARENT) { if (e.origin === PARENT) apply(d); return; }
      if (!VERIFY) return;
      if (verifying) {
        if (e.origin === verifying) { held.push(d); if (held.length > 50) held.shift(); }
        return;
      }
      if (d.method === "setNonce" && typeof d.arg === "string" && typeof d.token === "string") verify(e.origin, d);
    });
  }
  emit("ready", { url: location.href, title: document.title });
  try {
    var nav = performance.getEntriesByType("navigation")[0];
    if (nav) {
      var st = typeof nav.responseStatus === "number" && nav.responseStatus > 0 ? nav.responseStatus : 200;
      emit("network", { id: nid(), method: "GET", url: location.href, type: "other", at: Date.now(),
        status: st, statusText: st >= 400 ? "" : "OK", durationMs: nav.duration || null, requestBody: null, responseBody: null });
    }
    new PerformanceObserver(function (list) { list.getEntries().forEach(resource); })
      .observe({ type: "resource", buffered: true });
  } catch (e) {}
  return "installed";
})
`;

/**
 * The script with its channel's nonce; `executeJavaScript` it on each
 * `dom-ready`. The postMessage channel's script is served as a file (no
 * nonce yet: the host sends one with `setNonce`): by the daemon on a port's
 * address, and — with `verifyPath` ({@link SITE_PAGE_TOOLS_VERIFY_PATH}) — by
 * the console on the person's sites (fishcode `site_page_tools.js`, made by
 * `bun scripts/print-site-page-tools.ts`).
 */
export function buildPageToolsScript(
  nonce: string,
  channel: PageToolsChannel = "console",
  options: { readonly verifyPath?: string } = {},
): string {
  const verify = channel === "postMessage" && options.verifyPath ? options.verifyPath : "";
  const script = SCRIPT.trim().replace("__READ_SELECTION__", READ_SELECTION);
  return `${script}(${JSON.stringify(nonce)}, ${channel === "queue" ? "true" : "false"}, ${channel === "postMessage" ? "true" : "false"}, ${JSON.stringify(verify)});`;
}

/** The script the console puts on the person's Uno Sites pages. */
export function buildSitePageToolsScript(): string {
  return buildPageToolsScript("", "postMessage", { verifyPath: SITE_PAGE_TOOLS_VERIFY_PATH });
}
