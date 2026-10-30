/**
 * Comment on a page in the panel browser (w0139), as the page preload runs
 * it: a crosshair; hovering highlights an element with its name; a click
 * picks it, Shift+drag picks an area; numbered pins stay on the page. The
 * note itself is typed in the app, not in the page.
 *
 * The same behaviour as the in-page script of the mock
 * (apps/web …/annotate/pageToolsScript.ts — still used by the demo's iframe
 * and by desktop shells without this preload), but living in the page's
 * isolated world from its first moment:
 *   - the page can't see it, call it or fake its messages;
 *   - its capture listeners on `window` come before any of the page's own,
 *     so a click in Comment mode never reaches the page;
 *   - its styles are constructed sheets (a shadow root's own, and the
 *     crosshair), which a page's CSP doesn't block like a <style> tag.
 */
import type {
  PageToolsWireMessage,
  PageToolsWirePick,
  PageToolsWirePin,
} from "@t3tools/contracts/pageTools";

type Emit = (message: PageToolsWireMessage) => void;

const ACCENT = "#5b5bd6";
const HOST_TAG = "uno-page-tools";
const COMMENTING_CLASS = "__uno-commenting";
const SELECTION_MAX_TEXT = 8_000;

const SHADOW_CSS = `
.hl{position:fixed;display:none;border:1.5px solid ${ACCENT};background:rgba(91,91,214,.08);border-radius:4px;pointer-events:none;box-sizing:border-box}
.hl.pending{background:rgba(91,91,214,.14);border-width:2px}
.lbl{position:absolute;left:-1.5px;bottom:100%;margin-bottom:3px;background:${ACCENT};color:#fff;font:500 11px/1.2 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:3px 6px;border-radius:4px;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}
.lbl.below{bottom:auto;top:100%;margin:3px 0 0}
.lbl i{font-style:normal;opacity:.75;margin-left:6px}
.area{position:fixed;display:none;border:1.5px dashed ${ACCENT};background:rgba(91,91,214,.08);border-radius:4px;box-sizing:border-box}
.pin{position:fixed;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:${ACCENT};color:#fff;font:600 11px/20px ui-sans-serif,system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff,0 1px 4px rgba(0,0,0,.35);pointer-events:auto;cursor:pointer}
.mark{position:fixed;border:1.5px solid rgba(91,91,214,.55);border-radius:4px;box-sizing:border-box}
.mark.area{display:block;border-style:dashed}
`;
const CURSOR_CSS = `html.${COMMENTING_CLASS}, html.${COMMENTING_CLASS} * { cursor: crosshair !important; }`;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function classesOf(el: Element): string[] {
  return Array.from(el.classList)
    .filter(
      (c) => !c.startsWith("__uno") && c.length < 32 && !/^(is|has)-/.test(c) && !/\d{4,}/.test(c),
    )
    .slice(0, 2);
}

function rectOf(r: Box) {
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function place(box: HTMLElement, r: Box): void {
  box.style.display = "block";
  box.style.left = `${r.left}px`;
  box.style.top = `${r.top}px`;
  box.style.width = `${r.width}px`;
  box.style.height = `${r.height}px`;
}

/** Comment mode keeps the click (and its kin) from the page. */
function block(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

export interface CommentLayer {
  setMode(mode: "comment" | "off"): void;
  setPins(pins: ReadonlyArray<PageToolsWirePin>): void;
  setPaused(paused: boolean): void;
}

export function installCommentLayer(win: Window & typeof globalThis, emit: Emit): CommentLayer {
  const doc = win.document;
  let mode: "comment" | "off" = "off";
  let paused = false;
  let pins: ReadonlyArray<PageToolsWirePin> = [];
  let dragging: { x: number; y: number; rect: Box | null } | null = null;
  let current: Element | null = null;

  let host: HTMLElement | null = null;
  let hl: HTMLDivElement | null = null;
  let hlLabel: HTMLSpanElement | null = null;
  let areaBox: HTMLDivElement | null = null;
  let pinsLayer: HTMLDivElement | null = null;
  let cursorSheet: CSSStyleSheet | null = null;

  const sheetOf = (css: string): CSSStyleSheet | null => {
    try {
      const sheet = new win.CSSStyleSheet();
      sheet.replaceSync(css);
      return sheet;
    } catch {
      return null;
    }
  };

  const ensureHost = (): boolean => {
    if (host?.isConnected && hl && hlLabel && areaBox && pinsLayer) return true;
    const root = doc.documentElement;
    if (!root) return false;
    host = doc.createElement(HOST_TAG);
    for (const [key, value] of [
      ["position", "fixed"],
      ["inset", "0"],
      ["pointer-events", "none"],
      ["z-index", "2147483647"],
      ["display", "block"],
    ] as const) {
      host.style.setProperty(key, value, "important");
    }
    const shadow = host.attachShadow({ mode: "closed" });
    const sheet = sheetOf(SHADOW_CSS);
    if (sheet) shadow.adoptedStyleSheets = [sheet];
    pinsLayer = doc.createElement("div");
    pinsLayer.className = "pins";
    hl = doc.createElement("div");
    hl.className = "hl";
    hlLabel = doc.createElement("span");
    hlLabel.className = "lbl";
    hl.appendChild(hlLabel);
    areaBox = doc.createElement("div");
    areaBox.className = "area";
    shadow.append(pinsLayer, hl, areaBox);
    root.appendChild(host);
    return true;
  };

  const setCursor = (on: boolean) => {
    if (on && !cursorSheet) cursorSheet = sheetOf(CURSOR_CSS);
    if (cursorSheet) {
      const others = doc.adoptedStyleSheets.filter((sheet) => sheet !== cursorSheet);
      doc.adoptedStyleSheets = on ? [...others, cursorSheet] : others;
    }
    doc.documentElement?.classList.toggle(COMMENTING_CLASS, on);
  };

  const esc = (value: string) =>
    win.CSS?.escape ? win.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  const partOf = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (el.id && !/\d{3,}/.test(el.id)) return `#${esc(el.id)}`;
    let selector =
      tag +
      classesOf(el)
        .map((c) => `.${esc(c)}`)
        .join("");
    const parent = el.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
      const sameSelector = sameTag.filter((c) => {
        try {
          return c.matches(selector);
        } catch {
          return false;
        }
      });
      if (sameSelector.length > 1) selector += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
    }
    return selector;
  };
  const selectorOf = (el: Element): string => {
    const parts: string[] = [];
    let cursor: Element | null = el;
    while (cursor && cursor !== doc.documentElement && parts.length < 6) {
      const part = partOf(cursor);
      parts.unshift(part);
      const selector = parts.join(" > ");
      try {
        if (doc.querySelectorAll(selector).length === 1) return selector;
      } catch {
        // an odd id or class: keep climbing
      }
      if (part.startsWith("#")) break;
      cursor = cursor.parentElement;
    }
    return parts.join(" > ");
  };
  const labelOf = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const classes = classesOf(el);
    return el.id ? `${tag}#${el.id}` : tag + (classes.length ? `.${classes[0]}` : "");
  };
  const textOf = (el: Element): string | null => {
    let text = "";
    if (el.tagName === "IMG") text = el.getAttribute("alt") || el.getAttribute("src") || "";
    else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      text = el.getAttribute("placeholder") || (el as HTMLInputElement).value || "";
    } else text = (el as HTMLElement).innerText || el.textContent || "";
    text = text.replace(/\s+/g, " ").trim();
    return text ? clip(text, 80) : null;
  };
  const docRectOf = (r: Box) => ({
    x: r.left + win.scrollX,
    y: r.top + win.scrollY,
    w: r.width,
    h: r.height,
  });
  const targetAt = (x: number, y: number): Element | null => {
    const el = doc.elementFromPoint(x, y);
    if (!el || el === host || el === doc.documentElement || el === doc.body) return null;
    return el;
  };
  const showHighlight = (el: Element | null) => {
    if (!ensureHost() || !hl || !hlLabel) return;
    current = el;
    if (!el) {
      hl.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    place(hl, r);
    hlLabel.className = r.top < 24 ? "lbl below" : "lbl";
    hlLabel.textContent = labelOf(el);
    const size = doc.createElement("i");
    size.textContent = `${Math.round(r.width)}×${Math.round(r.height)}`;
    hlLabel.appendChild(size);
  };
  // The shadow root is closed (the page can't reach into it), so events seen
  // on `window` don't name our pins: find the pin under the pointer instead.
  const pinOf = (event: MouseEvent): HTMLElement | null => {
    if (!pinsLayer) return null;
    for (const node of Array.from(pinsLayer.children)) {
      if (!(node instanceof win.HTMLElement) || !node.classList.contains("pin")) continue;
      const r = node.getBoundingClientRect();
      if (
        event.clientX >= r.left &&
        event.clientX <= r.right &&
        event.clientY >= r.top &&
        event.clientY <= r.bottom
      ) {
        return node;
      }
    }
    return null;
  };

  const onMove = (event: PointerEvent) => {
    if (mode !== "comment" || paused) return;
    if (dragging) {
      const r = {
        left: Math.min(dragging.x, event.clientX),
        top: Math.min(dragging.y, event.clientY),
        width: Math.abs(event.clientX - dragging.x),
        height: Math.abs(event.clientY - dragging.y),
      };
      dragging.rect = r;
      if (areaBox) place(areaBox, r);
      if (hl) hl.style.display = "none";
      return;
    }
    showHighlight(targetAt(event.clientX, event.clientY));
  };
  const onDown = (event: MouseEvent) => {
    if (mode !== "comment") return;
    const pin = pinOf(event);
    block(event);
    if (paused) return;
    if (pin) {
      emit({ type: "pinClick", data: { n: Number(pin.getAttribute("data-n")) } });
      return;
    }
    if (event.shiftKey && ensureHost())
      dragging = { x: event.clientX, y: event.clientY, rect: null };
  };
  const onUp = (event: MouseEvent) => {
    if (mode !== "comment") return;
    block(event);
    if (paused || !dragging) return;
    const drag = dragging;
    dragging = null;
    const r = drag.rect;
    if (!r || r.width <= 8 || r.height <= 8) {
      if (areaBox) areaBox.style.display = "none";
      return;
    }
    const inside: string[] = [];
    const all = doc.body?.querySelectorAll("h1,h2,h3,h4,p,a,button,img,input,label,li") ?? [];
    for (const el of Array.from(all)) {
      if (inside.length >= 4) break;
      const b = el.getBoundingClientRect();
      if (
        b.width &&
        b.left >= r.left &&
        b.top >= r.top &&
        b.right <= r.left + r.width &&
        b.bottom <= r.top + r.height
      ) {
        inside.push(labelOf(el));
      }
    }
    paused = true;
    const pick: PageToolsWirePick = {
      kind: "area",
      selector: null,
      label: `Area ${Math.round(r.width)}×${Math.round(r.height)}`,
      text: inside.length ? inside.join(", ") : null,
      rect: rectOf(r),
      docRect: docRectOf(r),
    };
    emit({ type: "pick", data: pick });
  };
  const onClick = (event: MouseEvent) => {
    if (mode !== "comment") return;
    block(event);
    if (paused || pinOf(event)) return;
    const el = current ?? targetAt(event.clientX, event.clientY);
    if (!el) return;
    const r = el.getBoundingClientRect();
    paused = true;
    hl?.classList.add("pending");
    emit({
      type: "pick",
      data: {
        kind: "element",
        selector: selectorOf(el),
        label: labelOf(el),
        text: textOf(el),
        rect: rectOf(r),
        docRect: docRectOf(r),
      },
    });
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    const typing =
      !!target &&
      (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ""));
    if (typing && event.key !== "Escape") return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    // One mode (Comment shows the console too): C toggles it, Esc leaves it.
    if (key === "c" || key === "Escape") {
      if (mode === "comment") block(event);
      emit({ type: "key", data: { key } });
    }
  };

  // The part of an element's box really on screen: not off the viewport,
  // not under a sticky header (or anything else drawn on top).
  const visibleRect = (el: Element, r: DOMRect): Box | null => {
    let top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, win.innerHeight);
    if (bottom - top < 4 || r.right < 0 || r.left > win.innerWidth) return null;
    const x = Math.min(Math.max(r.left + r.width / 2, 1), win.innerWidth - 1);
    for (let guard = 0; guard < 4; guard += 1) {
      const hit = doc.elementFromPoint(x, top + 1);
      if (!hit || hit === el || el.contains(hit) || hit.contains(el) || hit === host) break;
      const cover = hit.getBoundingClientRect();
      if (cover.bottom >= bottom - 2) return null;
      top = Math.max(top, cover.bottom);
    }
    return { left: r.left, top, width: r.width, height: bottom - top };
  };
  const drawPins = () => {
    if (!pinsLayer) return;
    pinsLayer.replaceChildren();
    pinsLayer.style.display = "none";
    const shown: Array<{ pin: PageToolsWirePin; r: Box }> = [];
    for (const pin of pins) {
      let el: Element | null = null;
      if (pin.kind === "element" && pin.selector) {
        try {
          el = doc.querySelector(pin.selector);
        } catch {
          el = null;
        }
      }
      let r: Box | null;
      if (el) r = visibleRect(el, el.getBoundingClientRect());
      else {
        const a = {
          left: pin.docRect.x - win.scrollX,
          top: pin.docRect.y - win.scrollY,
          width: pin.docRect.w,
          height: pin.docRect.h,
        };
        const top = Math.max(a.top, 0);
        const bottom = Math.min(a.top + a.height, win.innerHeight);
        r = bottom - top >= 4 ? { left: a.left, top, width: a.width, height: bottom - top } : null;
      }
      if (r) shown.push({ pin, r });
    }
    pinsLayer.style.display = "";
    for (const item of shown) {
      const mark = doc.createElement("div");
      mark.className = item.pin.kind === "area" ? "mark area" : "mark";
      place(mark, item.r);
      const pinEl = doc.createElement("div");
      pinEl.className = "pin";
      pinEl.setAttribute("data-n", String(item.pin.n));
      pinEl.textContent = String(item.pin.n);
      pinEl.style.left = `${Math.min(Math.max(item.r.left + item.r.width, 12), win.innerWidth - 12)}px`;
      pinEl.style.top = `${Math.min(Math.max(item.r.top, 12), win.innerHeight - 12)}px`;
      pinsLayer.append(mark, pinEl);
    }
  };
  let raf = 0;
  const redraw = () => {
    if (raf) return;
    raf = win.requestAnimationFrame(() => {
      raf = 0;
      drawPins();
      if (paused && current && hl && hl.style.display !== "none") showHighlight(current);
    });
  };

  for (const type of ["pointerdown", "mousedown"] as const)
    win.addEventListener(type, onDown, true);
  for (const type of ["pointerup", "mouseup"] as const) win.addEventListener(type, onUp, true);
  for (const type of ["click", "dblclick", "auxclick", "contextmenu"] as const) {
    win.addEventListener(type, onClick, true);
  }
  win.addEventListener("pointermove", onMove, true);
  win.addEventListener("keydown", onKey, true);
  win.addEventListener("scroll", redraw, true);

  // Text selected on the page: the app offers a quote over it (the same as
  // the in-page script's). A selection inside a field may be a password.
  let selectionTimer: number | null = null;
  let selecting = false;
  let lastSelection = "";
  const reportSelection = () => {
    selectionTimer = null;
    if (selecting) return;
    const selection = win.getSelection();
    const active = doc.activeElement as HTMLElement | null;
    const inField =
      !!active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
    const text =
      mode === "off" && selection && !selection.isCollapsed && selection.rangeCount && !inField
        ? selection.toString().trim()
        : "";
    const rect = { x: 0, y: 0, w: 0, h: 0 };
    if (text && selection) {
      const range = selection.getRangeAt(0);
      const lines = range.getClientRects();
      const last = lines.item(lines.length - 1) ?? range.getBoundingClientRect();
      Object.assign(rect, { x: last.left, y: last.top, w: last.width, h: last.height });
    }
    const key = text ? `${text}|${Math.round(rect.x)}|${Math.round(rect.y)}` : "";
    if (key === lastSelection) return;
    lastSelection = key;
    emit({
      type: "selection",
      data: { text: text.slice(0, SELECTION_MAX_TEXT), url: win.location.href, rect },
    });
  };
  const reportSelectionSoon = () => {
    selectionTimer ??= win.setTimeout(reportSelection, 120);
  };
  doc.addEventListener("selectionchange", reportSelectionSoon);
  win.addEventListener(
    "pointerdown",
    () => {
      selecting = true;
    },
    true,
  );
  win.addEventListener(
    "pointerup",
    () => {
      selecting = false;
      reportSelectionSoon();
    },
    true,
  );
  win.addEventListener(
    "scroll",
    () => {
      if (lastSelection) reportSelectionSoon();
    },
    true,
  );
  win.addEventListener("resize", redraw);

  return {
    setMode(next) {
      mode = next === "comment" ? "comment" : "off";
      setCursor(mode === "comment");
      ensureHost();
      if (mode !== "comment") {
        if (hl) hl.style.display = "none";
        if (areaBox) areaBox.style.display = "none";
        paused = false;
        dragging = null;
      }
    },
    setPins(list) {
      ensureHost();
      pins = Array.isArray(list) ? list : [];
      drawPins();
    },
    setPaused(on) {
      paused = !!on;
      if (!paused && ensureHost()) {
        hl?.classList.remove("pending");
        if (hl) hl.style.display = "none";
        if (areaBox) areaBox.style.display = "none";
        current = null;
      }
    },
  };
}
