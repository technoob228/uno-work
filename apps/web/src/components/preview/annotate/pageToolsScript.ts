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
 */

export const PAGE_TOOLS_GLOBAL = "__unoPageTools";

export type PageToolsMessage =
  | { readonly type: "ready"; readonly data: { readonly url: string; readonly title: string } }
  | { readonly type: "console"; readonly data: unknown }
  | { readonly type: "network"; readonly data: unknown }
  | { readonly type: "pick"; readonly data: PagePick }
  | { readonly type: "pinClick"; readonly data: { readonly n: number } }
  | { readonly type: "key"; readonly data: { readonly key: string } };

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

/** A call into the installed script; harmless on a page that doesn't have it (yet). */
export function pageToolsCall(method: "setMode" | "setPins" | "setPaused", arg: unknown): string {
  return `(function(t){ if (t) t.${method}(${JSON.stringify(arg)}); return true; })(window.${PAGE_TOOLS_GLOBAL})`;
}

const SCRIPT = String.raw`
(function (NONCE) {
  var w = window;
  var G = "${PAGE_TOOLS_GLOBAL}";
  if (w[G] && w[G].nonce === NONCE && w[G].doc === document) return "already";
  var origDebug = console.debug.bind(console);
  function emit(type, data) {
    try { origDebug(NONCE + JSON.stringify({ type: type, data: data })); } catch (e) {}
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
  function onUp(e) {
    if (mode !== "comment") return;
    block(e);
    if (paused) return;
    if (dragging) {
      var d = dragging; dragging = null;
      if (d.rect && d.rect.width > 8 && d.rect.height > 8) {
        var inside = [];
        var all = document.body ? document.body.querySelectorAll("h1,h2,h3,h4,p,a,button,img,input,label,li") : [];
        for (var i = 0; i < all.length && inside.length < 4; i++) {
          var b = all[i].getBoundingClientRect();
          if (b.width && b.left >= d.rect.left && b.top >= d.rect.top && b.right <= d.rect.left + d.rect.width && b.bottom <= d.rect.top + d.rect.height) inside.push(labelOf(all[i]));
        }
        paused = true;
        emit("pick", { kind: "area", selector: null,
          label: "Area " + Math.round(d.rect.width) + "×" + Math.round(d.rect.height),
          text: inside.length ? inside.join(", ") : null,
          rect: rectOf(d.rect), docRect: docRectOf(d.rect) });
      } else areaBox.style.display = "none";
      return;
    }
  }
  function onClick(e) {
    if (mode !== "comment") return;
    block(e);
    if (paused || inPin(e)) return;
    var el = current || targetAt(e.clientX, e.clientY);
    if (!el) return;
    var r = el.getBoundingClientRect();
    paused = true;
    hl.classList.add("pending");
    emit("pick", { kind: "element", selector: selectorOf(el), label: labelOf(el), text: textOf(el),
      rect: rectOf(r), docRect: docRectOf(r) });
  }
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
    }
  };

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

/** The script with its channel's nonce; `executeJavaScript` it on each `dom-ready`. */
export function buildPageToolsScript(nonce: string): string {
  return `${SCRIPT.trim()}(${JSON.stringify(nonce)});`;
}
