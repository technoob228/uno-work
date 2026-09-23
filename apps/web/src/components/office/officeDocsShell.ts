/**
 * "Docs shell": our own calm toolbar for Word documents on top of the
 * ONLYOFFICE engine (Labs flag `officeDocsShell`, off by default).
 *
 * The engine keeps doing all the real work. The shell only:
 *   - hides the engine's own chrome inside its iframe with a stylesheet (ribbon,
 *     status bar, left/right side bars, rulers) — the engine's layout skips
 *     hidden panels, so the page simply gets the room;
 *   - listens to the engine's selection callbacks (`asc_onBold`,
 *     `asc_onParaStyleName`, …) so our buttons show the current formatting;
 *   - runs commands through the same editor API the ribbon calls
 *     (`put_TextPrBold`, `put_Style`, …). Anything with a dialog (link, table,
 *     image by URL, find & replace, paragraph settings) is handed to the
 *     engine's own controllers, so their dialogs open as before.
 *
 * The iframe is same-origin (the engine is served by the Work daemon), so the
 * parent page reaches `window.Asc.editor` and `window.DE` directly. Nothing
 * in the engine package is modified.
 *
 * "Full toolbar" brings the engine's ribbon back for everything the shell
 * doesn't cover (layout, references, styles gallery, review…).
 */

export type DocsAlign = "left" | "center" | "right" | "justify";
export type DocsList = "bullet" | "number" | null;

export interface DocsFormatState {
  /** Paragraph style name as the engine reports it ("Normal", "Heading 1"…). */
  readonly style: string | null;
  readonly fontName: string | null;
  readonly fontSize: number | null;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strikeout: boolean;
  readonly align: DocsAlign | null;
  readonly list: DocsList;
  /** Hex "rrggbb", or null for automatic. */
  readonly color: string | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly zoom: number | null;
  /** The engine's own ribbon is shown ("Full toolbar"). */
  readonly fullToolbar: boolean;
}

export const INITIAL_DOCS_STATE: DocsFormatState = {
  style: null,
  fontName: null,
  fontSize: null,
  bold: false,
  italic: false,
  underline: false,
  strikeout: false,
  align: null,
  list: null,
  color: null,
  canUndo: false,
  canRedo: false,
  zoom: null,
  fullToolbar: false,
};

export type DocsCommand =
  | { type: "undo" }
  | { type: "redo" }
  | { type: "bold" }
  | { type: "italic" }
  | { type: "underline" }
  | { type: "strikeout" }
  | { type: "style"; name: string }
  | { type: "fontName"; name: string }
  | { type: "fontSize"; size: number }
  | { type: "align"; align: DocsAlign }
  | { type: "list"; list: "bullet" | "number" }
  | { type: "indent"; direction: "in" | "out" }
  | { type: "color"; hex: string | null }
  | { type: "highlight"; hex: string | null }
  | { type: "clearFormatting" }
  | { type: "link" }
  | { type: "comment" }
  | { type: "imageFromFile" }
  | { type: "imageFromUrl" }
  | { type: "table" }
  | { type: "pageBreak" }
  | { type: "find" }
  | { type: "replace" }
  | { type: "print" }
  | { type: "zoom"; percent: number }
  | { type: "zoomFitWidth" }
  | { type: "fullToolbar"; show: boolean };

/** Paragraph styles offered in the style menu, in Google Docs order. */
export const DOCS_STYLES: ReadonlyArray<{ readonly name: string; readonly label: string }> = [
  { name: "Normal", label: "Normal text" },
  { name: "Title", label: "Title" },
  { name: "Subtitle", label: "Subtitle" },
  { name: "Heading 1", label: "Heading 1" },
  { name: "Heading 2", label: "Heading 2" },
  { name: "Heading 3", label: "Heading 3" },
];

/** Common families; only those the engine actually has are offered. */
export const DOCS_FONTS: ReadonlyArray<string> = [
  "Arial",
  "Calibri",
  "Cambria",
  "Comic Sans MS",
  "Courier New",
  "Georgia",
  "Open Sans",
  "Roboto",
  "Tahoma",
  "Times New Roman",
  "Trebuchet MS",
  "Verdana",
];

export const DOCS_FONT_SIZES: ReadonlyArray<number> = [
  8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72,
];

/** Google-Docs-like palette (text color and highlight share it). */
export const DOCS_COLORS: ReadonlyArray<string> = [
  "000000",
  "434343",
  "666666",
  "999999",
  "b7b7b7",
  "d9d9d9",
  "980000",
  "e03131",
  "f08c00",
  "f5c518",
  "2f9e44",
  "1971c2",
  "4263eb",
  "7048e8",
  "c2255c",
  "0c8599",
];

export function styleLabel(name: string | null): string {
  if (!name) return "Normal text";
  const known = DOCS_STYLES.find((style) => style.name.toLowerCase() === name.toLowerCase());
  return known ? known.label : name;
}

/**
 * The engine's paragraph alignment codes (LTR text): 0 right, 1 left,
 * 2 center, 3 justify — see `onApiParagraphAlign` in the engine's toolbar.
 */
const ALIGN_TO_ENGINE: Record<DocsAlign, number> = { right: 0, left: 1, center: 2, justify: 3 };

export function alignFromEngine(value: unknown): DocsAlign | null {
  switch (value) {
    case 0:
      return "right";
    case 1:
      return "left";
    case 2:
      return "center";
    case 3:
      return "justify";
    default:
      return null;
  }
}

export function alignToEngine(align: DocsAlign): number {
  return ALIGN_TO_ENGINE[align];
}

/** "#FF00aa" / "ff00aa" → [255, 0, 170]; null when it isn't a hex color. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return [r, g, b]
    .map((part) => Math.max(0, Math.min(255, part)).toString(16).padStart(2, "0"))
    .join("");
}

/** Clamp and round like the engine's own size box (1–300 pt, half points). */
export function normalizeFontSize(size: number): number | null {
  if (!Number.isFinite(size)) return null;
  const clamped = Math.min(300, Math.max(1, size));
  return Math.round(clamped * 2) / 2;
}

/** Next size up/down in the preset list (for the − / + buttons). */
export function stepFontSize(current: number | null, direction: 1 | -1): number {
  const base = current ?? 11;
  if (direction > 0) return DOCS_FONT_SIZES.find((size) => size > base) ?? Math.min(300, base + 12);
  const smaller = DOCS_FONT_SIZES.filter((size) => size < base);
  return smaller.length > 0 ? smaller[smaller.length - 1]! : Math.max(1, base - 1);
}

/* ------------------------------------------------------------------ engine */

/** The slice of the engine's editor API the shell uses (window.Asc.editor). */
export interface DocsEngineApi {
  asc_registerCallback(name: string, callback: (...args: never[]) => void): void;
  asc_unregisterCallback?(name: string, callback: (...args: never[]) => void): void;
  Undo(): void;
  Redo(): void;
  put_TextPrBold(value: boolean): void;
  put_TextPrItalic(value: boolean): void;
  put_TextPrUnderline(value: boolean): void;
  put_TextPrStrikeout(value: boolean): void;
  put_Style(name: string): void;
  put_TextPrFontName(name: string): void;
  put_TextPrFontSize(size: number): void;
  put_PrAlign(value: number): void;
  put_ListTypeCustom(info: { Type: "bullet" | "number" | "remove" }): unknown;
  IncreaseIndent(): void;
  DecreaseIndent(): void;
  put_TextColor(color: unknown): void;
  SetMarkerFormat(isMarker: boolean, hasColor: boolean, r?: number, g?: number, b?: number): void;
  ClearFormating(): void;
  put_AddPageBreak(): void;
  asc_addImage(): void;
  asc_SetViewRulers?(value: boolean): void;
  asc_GetCurrentNumberingId?(): unknown;
  asc_GetNumberingPr?(id: unknown): { get_Lvl(level: number): { get_Format(): number } } | null;
  asc_GetCurrentNumberingLvl?(): number;
  zoom?(percent: number): void;
  zoomFitToWidth?(): void;
  UpdateInterfaceState?(): void;
  asc_getCanUndo?(): boolean;
  asc_getCanRedo?(): boolean;
}

interface EngineColor {
  get_auto?: () => boolean;
  get_r: () => number;
  get_g: () => number;
  get_b: () => number;
}

interface EngineController {
  [method: string]: unknown;
}

/** What the shell reaches inside the editor iframe. */
export interface DocsEngineWindow {
  document: Document;
  JSON?: JSON;
  Asc?: {
    editor?: DocsEngineApi;
    asc_CColor?: new (r: number, g: number, b: number) => unknown;
    c_oAscNumberingFormat?: { None: number; Bullet: number };
  };
  DE?: { getController(name: string): EngineController | undefined };
  Common?: {
    NotificationCenter?: { trigger(event: string, ...args: unknown[]): void };
  };
  dispatchEvent(event: Event): boolean;
  focus(): void;
  innerWidth: number;
}

export const DOCS_SHELL_STYLE_ID = "uno-docs-shell";

/** Editor narrower than this opens at "fit width" instead of 100%. */
export const DOCS_FIT_WIDTH_BELOW_PX = 860;

/**
 * Hides the engine's chrome. `html.uno-docs-full` brings the ribbon back;
 * `html.uno-docs-side` shows the left bar (find & replace, comments list).
 */
export const DOCS_SHELL_CSS = `
html:not(.uno-docs-full) #toolbar,
html:not(.uno-docs-full) #statusbar,
html:not(.uno-docs-full):not(.uno-docs-side) #left-menu,
html:not(.uno-docs-full) #right-menu { display: none !important; }
`;

export function installDocsShellStyle(doc: Document): boolean {
  if (!doc.head) return false;
  if (doc.getElementById(DOCS_SHELL_STYLE_ID)) return true;
  const style = doc.createElement("style");
  style.id = DOCS_SHELL_STYLE_ID;
  style.textContent = DOCS_SHELL_CSS;
  doc.head.appendChild(style);
  return true;
}

function controller(win: DocsEngineWindow, name: string): EngineController | undefined {
  try {
    return win.DE?.getController(name);
  } catch {
    return undefined;
  }
}

function callController(win: DocsEngineWindow, name: string, method: string, ...args: unknown[]) {
  const target = controller(win, name);
  const fn = target?.[method];
  if (typeof fn !== "function") throw new Error(`Office engine has no ${name}.${method}`);
  return (fn as (...a: unknown[]) => unknown).apply(target, args);
}

/** Current list kind at the cursor, the same way the engine's ribbon finds it. */
export function readListKind(win: DocsEngineWindow, api: DocsEngineApi): DocsList {
  try {
    const id = api.asc_GetCurrentNumberingId?.();
    if (id === null || id === undefined) return null;
    const formats = win.Asc?.c_oAscNumberingFormat;
    const level = api.asc_GetCurrentNumberingLvl?.() ?? 0;
    const format = api.asc_GetNumberingPr?.(id)?.get_Lvl(level).get_Format();
    if (!formats || format === undefined) return "bullet";
    if (format === formats.Bullet || format === formats.None) return "bullet";
    return "number";
  } catch {
    return null;
  }
}

/** Maps a shell command to engine calls. Exported for tests. */
export function runDocsCommand(
  win: DocsEngineWindow,
  api: DocsEngineApi,
  state: DocsFormatState,
  command: DocsCommand,
): void {
  switch (command.type) {
    case "undo":
      api.Undo();
      return;
    case "redo":
      api.Redo();
      return;
    case "bold":
      api.put_TextPrBold(!state.bold);
      return;
    case "italic":
      api.put_TextPrItalic(!state.italic);
      return;
    case "underline":
      api.put_TextPrUnderline(!state.underline);
      return;
    case "strikeout":
      api.put_TextPrStrikeout(!state.strikeout);
      return;
    case "style":
      api.put_Style(command.name);
      return;
    case "fontName":
      api.put_TextPrFontName(command.name);
      return;
    case "fontSize": {
      const size = normalizeFontSize(command.size);
      if (size !== null) api.put_TextPrFontSize(size);
      return;
    }
    case "align":
      api.put_PrAlign(alignToEngine(command.align));
      return;
    case "list": {
      // Built with the iframe's own JSON: an object from this page (another
      // realm) is silently ignored by the engine — checked on 2026-09-23.
      const info = JSON.stringify({ Type: state.list === command.list ? "remove" : command.list });
      api.put_ListTypeCustom((win.JSON ?? JSON).parse(info));
      return;
    }
    case "indent":
      if (command.direction === "in") api.IncreaseIndent();
      else api.DecreaseIndent();
      return;
    case "color": {
      const Color = win.Asc?.asc_CColor;
      if (!Color) return;
      if (command.hex === null) {
        const auto = new Color(0, 0, 0) as { put_auto?: (value: boolean) => void };
        auto.put_auto?.(true);
        api.put_TextColor(auto);
        return;
      }
      const rgb = hexToRgb(command.hex);
      if (rgb) api.put_TextColor(new Color(rgb[0], rgb[1], rgb[2]));
      return;
    }
    case "highlight": {
      const rgb = command.hex === null ? null : hexToRgb(command.hex);
      if (rgb) api.SetMarkerFormat(true, true, rgb[0], rgb[1], rgb[2]);
      else api.SetMarkerFormat(true, false);
      return;
    }
    case "clearFormatting":
      api.ClearFormating();
      return;
    case "pageBreak":
      api.put_AddPageBreak();
      return;
    case "imageFromFile":
      api.asc_addImage();
      return;
    case "imageFromUrl":
      callController(win, "Toolbar", "onInsertImageClick", null, { value: "url" });
      return;
    case "table":
      callController(win, "Toolbar", "onInsertTableClick", null, { value: "custom" });
      return;
    case "link":
      callController(win, "Links", "onHyperlinkClick", undefined);
      return;
    case "comment":
      callController(win, "Common.Controllers.Comments", "addDummyComment");
      return;
    case "find":
      win.Common?.NotificationCenter?.trigger("search:show");
      return;
    case "replace":
      win.document.documentElement.classList.add("uno-docs-side");
      win.dispatchEvent(new Event("resize"));
      callController(win, "LeftMenu", "onShortcut", "replace");
      return;
    case "print":
      win.Common?.NotificationCenter?.trigger("file:print");
      return;
    case "zoom":
      api.zoom?.(command.percent);
      return;
    case "zoomFitWidth":
      api.zoomFitToWidth?.();
      return;
    case "fullToolbar":
      win.document.documentElement.classList.toggle("uno-docs-full", command.show);
      win.dispatchEvent(new Event("resize"));
      return;
  }
}

/** "Report.final.docx" → { base: "Report.final", extension: ".docx" }. */
export function splitDocName(fileName: string): { base: string; extension: string } {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) return { base: fileName, extension: "" };
  return { base: fileName.slice(0, dot), extension: fileName.slice(dot) };
}

/** Commands after which the text should get the keyboard back (not dialogs). */
export function commandReturnsFocus(command: DocsCommand): boolean {
  return !(
    command.type === "link" ||
    command.type === "table" ||
    command.type === "imageFromUrl" ||
    command.type === "imageFromFile" ||
    command.type === "find" ||
    command.type === "replace" ||
    command.type === "print" ||
    command.type === "comment"
  );
}

export interface DocsShell {
  getState(): DocsFormatState;
  subscribe(listener: () => void): () => void;
  run(command: DocsCommand): void;
  /** Fonts from DOCS_FONTS the engine has, plus the one at the cursor. */
  fonts(): string[];
  /** Give the keyboard back to the document. */
  focus(): void;
  detach(): void;
}

/**
 * Attaches the shell to a loaded editor iframe window. Returns null when the
 * engine isn't ready yet (no `Asc.editor`) — call again on the next tick.
 */
export function attachDocsShell(win: DocsEngineWindow): DocsShell | null {
  const api = win.Asc?.editor;
  if (!api || !win.document?.head) return null;
  installDocsShellStyle(win.document);

  let state: DocsFormatState = { ...INITIAL_DOCS_STATE };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<DocsFormatState>) => {
    let changed = false;
    for (const [key, value] of Object.entries(patch) as [keyof DocsFormatState, unknown][]) {
      if (state[key] !== value) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const callbacks: Array<[string, (...args: never[]) => void]> = [
    ["asc_onParaStyleName", ((name: string) => set({ style: name || null })) as never],
    [
      "asc_onFontFamily",
      ((font: { get_Name?: () => string; asc_getFontName?: () => string }) =>
        set({ fontName: font?.get_Name?.() ?? font?.asc_getFontName?.() ?? null })) as never,
    ],
    [
      "asc_onFontSize",
      ((size: number) => set({ fontSize: typeof size === "number" ? size : null })) as never,
    ],
    ["asc_onBold", ((value: boolean) => set({ bold: Boolean(value) })) as never],
    ["asc_onItalic", ((value: boolean) => set({ italic: Boolean(value) })) as never],
    ["asc_onUnderline", ((value: boolean) => set({ underline: Boolean(value) })) as never],
    ["asc_onStrikeout", ((value: boolean) => set({ strikeout: Boolean(value) })) as never],
    ["asc_onPrAlign", ((value: number) => set({ align: alignFromEngine(value) })) as never],
    [
      "asc_onTextColor",
      ((color: EngineColor | null) =>
        set({
          color:
            !color || color.get_auto?.()
              ? null
              : rgbToHex(color.get_r(), color.get_g(), color.get_b()),
        })) as never,
    ],
    ["asc_onCanUndo", ((value: boolean) => set({ canUndo: Boolean(value) })) as never],
    ["asc_onCanRedo", ((value: boolean) => set({ canRedo: Boolean(value) })) as never],
    [
      "asc_onZoomChange",
      ((percent: number) => set({ zoom: typeof percent === "number" ? percent : null })) as never,
    ],
    ["asc_onFocusObject", (() => set({ list: readListKind(win, api) })) as never],
  ];
  for (const [name, callback] of callbacks) api.asc_registerCallback(name, callback);

  // Rulers off for this session only (the ribbon's own setting lives in the
  // engine's localStorage and is left alone).
  try {
    api.asc_SetViewRulers?.(false);
  } catch {
    /* older engine */
  }
  win.dispatchEvent(new Event("resize"));
  win.Common?.NotificationCenter?.trigger("layout:changed", "rulers");
  // The engine announced the cursor's formatting before we subscribed; ask
  // it to announce again.
  try {
    api.UpdateInterfaceState?.();
    set({
      canUndo: Boolean(api.asc_getCanUndo?.()),
      canRedo: Boolean(api.asc_getCanRedo?.()),
      list: readListKind(win, api),
    });
  } catch {
    /* state fills in on the first click */
  }

  // A page doesn't fit a narrow window at 100%: start at "fit width".
  try {
    if (win.innerWidth > 0 && win.innerWidth < DOCS_FIT_WIDTH_BELOW_PX) api.zoomFitToWidth?.();
  } catch {
    /* keep the engine's zoom */
  }

  const focus = () => {
    try {
      win.focus();
      win.Common?.NotificationCenter?.trigger("edit:complete");
    } catch {
      /* iframe gone */
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run(command) {
      runDocsCommand(win, api, state, command);
      if (command.type === "fullToolbar") set({ fullToolbar: command.show });
      if (command.type === "list") set({ list: readListKind(win, api) });
      if (commandReturnsFocus(command)) focus();
    },
    fonts() {
      let available: string[] = [];
      try {
        const store = (
          controller(win, "Toolbar")?.toolbar as
            | { cmbFontName?: { store?: { pluck?: (key: string) => string[] } } }
            | undefined
        )?.cmbFontName?.store;
        available = store?.pluck?.("name") ?? [];
      } catch {
        available = [];
      }
      const have = new Set(available);
      const list =
        available.length > 0 ? DOCS_FONTS.filter((font) => have.has(font)) : [...DOCS_FONTS];
      if (state.fontName && !list.includes(state.fontName)) list.unshift(state.fontName);
      return list;
    },
    focus,
    detach() {
      listeners.clear();
      for (const [name, callback] of callbacks) {
        try {
          api.asc_unregisterCallback?.(name, callback);
        } catch {
          /* iframe gone */
        }
      }
    },
  };
}
