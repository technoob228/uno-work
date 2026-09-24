import { describe, expect, it, vi } from "vitest";

import { resolveFeatureFlag } from "../../featureFlags";
import {
  DOCS_SHELL_STYLE_ID,
  INITIAL_DOCS_STATE,
  alignFromEngine,
  alignToEngine,
  attachDocsShell,
  commandReturnsFocus,
  hexToRgb,
  normalizeFontSize,
  rgbToHex,
  runDocsCommand,
  splitDocName,
  stepFontSize,
  styleLabel,
  type DocsEngineApi,
  type DocsEngineWindow,
} from "./officeDocsShell";

/** A stand-in for the editor iframe: its document, `Asc.editor` and controllers. */
function fakeEngine(options: { numberingFormat?: number | null; width?: number } = {}) {
  const callbacks = new Map<string, Array<(...args: unknown[]) => void>>();
  const appended: Array<{ id: string; textContent: string }> = [];
  const classes = new Set<string>();
  const api = {
    asc_registerCallback: vi.fn((name: string, cb: (...args: unknown[]) => void) => {
      callbacks.set(name, [...(callbacks.get(name) ?? []), cb]);
    }),
    asc_unregisterCallback: vi.fn((name: string, cb: (...args: unknown[]) => void) => {
      callbacks.set(
        name,
        (callbacks.get(name) ?? []).filter((item) => item !== cb),
      );
    }),
    Undo: vi.fn(),
    Redo: vi.fn(),
    put_TextPrBold: vi.fn(),
    put_TextPrItalic: vi.fn(),
    put_TextPrUnderline: vi.fn(),
    put_TextPrStrikeout: vi.fn(),
    put_Style: vi.fn(),
    put_TextPrFontName: vi.fn(),
    put_TextPrFontSize: vi.fn(),
    put_PrAlign: vi.fn(),
    put_ListTypeCustom: vi.fn(),
    IncreaseIndent: vi.fn(),
    DecreaseIndent: vi.fn(),
    put_TextColor: vi.fn(),
    SetMarkerFormat: vi.fn(),
    ClearFormating: vi.fn(),
    put_AddPageBreak: vi.fn(),
    asc_addImage: vi.fn(),
    asc_SetViewRulers: vi.fn(),
    UpdateInterfaceState: vi.fn(),
    asc_getCanUndo: vi.fn(() => true),
    asc_getCanRedo: vi.fn(() => false),
    asc_GetCurrentNumberingId: vi.fn(() => (options.numberingFormat == null ? null : "n1")),
    asc_GetCurrentNumberingLvl: vi.fn(() => 0),
    asc_GetNumberingPr: vi.fn(() => ({
      get_Lvl: () => ({ get_Format: () => options.numberingFormat ?? 0 }),
    })),
    zoom: vi.fn(),
    zoomFitToWidth: vi.fn(),
  } satisfies DocsEngineApi;
  const controllers: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {
    Toolbar: { onInsertTableClick: vi.fn(), onInsertImageClick: vi.fn() },
    Links: { onHyperlinkClick: vi.fn() },
    LeftMenu: { onShortcut: vi.fn() },
    "Common.Controllers.Comments": { addDummyComment: vi.fn() },
  };
  const trigger = vi.fn();
  class CColor {
    constructor(
      readonly r: number,
      readonly g: number,
      readonly b: number,
    ) {}
    auto = false;
    put_auto(value: boolean) {
      this.auto = value;
    }
  }
  const doc = {
    head: {
      appendChild: (node: { id: string; textContent: string }) => appended.push(node),
    },
    getElementById: (id: string) => appended.find((node) => node.id === id) ?? null,
    createElement: () => ({ id: "", textContent: "" }),
    documentElement: {
      classList: {
        add: (name: string) => classes.add(name),
        toggle: (name: string, force?: boolean) => {
          const on = force ?? !classes.has(name);
          if (on) classes.add(name);
          else classes.delete(name);
          return on;
        },
      },
    },
  };
  const win = {
    document: doc as unknown as Document,
    JSON,
    Asc: {
      editor: api,
      asc_CColor: CColor,
      c_oAscNumberingFormat: { None: 0, Bullet: 1 },
    },
    DE: { getController: (name: string) => controllers[name] },
    Common: { NotificationCenter: { trigger } },
    dispatchEvent: vi.fn(() => true),
    focus: vi.fn(),
    innerWidth: options.width ?? 1200,
  } satisfies DocsEngineWindow;
  const fire = (name: string, ...args: unknown[]) => {
    for (const cb of callbacks.get(name) ?? []) cb(...args);
  };
  return { api, win, controllers, trigger, appended, classes, callbacks, fire };
}

describe("officeDocsShell helpers", () => {
  it("maps the engine's alignment codes both ways", () => {
    expect(alignFromEngine(0)).toBe("right");
    expect(alignFromEngine(1)).toBe("left");
    expect(alignFromEngine(2)).toBe("center");
    expect(alignFromEngine(3)).toBe("justify");
    expect(alignFromEngine(undefined)).toBeNull();
    for (const align of ["left", "center", "right", "justify"] as const) {
      expect(alignFromEngine(alignToEngine(align))).toBe(align);
    }
  });

  it("converts colors", () => {
    expect(hexToRgb("#E03131")).toEqual([224, 49, 49]);
    expect(hexToRgb("e03131")).toEqual([224, 49, 49]);
    expect(hexToRgb("red")).toBeNull();
    expect(rgbToHex(224, 49, 49)).toBe("e03131");
    expect(rgbToHex(-4, 300, 0)).toBe("00ff00");
  });

  it("clamps and steps font sizes like the engine", () => {
    expect(normalizeFontSize(0)).toBe(1);
    expect(normalizeFontSize(999)).toBe(300);
    expect(normalizeFontSize(10.3)).toBe(10.5);
    expect(normalizeFontSize(Number.NaN)).toBeNull();
    expect(stepFontSize(11, 1)).toBe(12);
    expect(stepFontSize(11, -1)).toBe(10);
    expect(stepFontSize(13, 1)).toBe(14);
    expect(stepFontSize(72, 1)).toBe(84);
    expect(stepFontSize(8, -1)).toBe(7);
    expect(stepFontSize(null, 1)).toBe(12);
  });

  it("labels styles the Google Docs way and keeps unknown ones", () => {
    expect(styleLabel("Normal")).toBe("Normal text");
    expect(styleLabel("heading 2")).toBe("Heading 2");
    expect(styleLabel(null)).toBe("Normal text");
    expect(styleLabel("List Paragraph")).toBe("List Paragraph");
  });

  it("splits a document name into what can be renamed and its extension", () => {
    expect(splitDocName("Report.final.docx")).toEqual({ base: "Report.final", extension: ".docx" });
    expect(splitDocName("README")).toEqual({ base: "README", extension: "" });
    expect(splitDocName(".docx")).toEqual({ base: ".docx", extension: "" });
  });

  it("keeps dialogs focused instead of snapping back to the text", () => {
    expect(commandReturnsFocus({ type: "bold" })).toBe(true);
    expect(commandReturnsFocus({ type: "style", name: "Title" })).toBe(true);
    expect(commandReturnsFocus({ type: "link" })).toBe(false);
    expect(commandReturnsFocus({ type: "table" })).toBe(false);
    expect(commandReturnsFocus({ type: "find" })).toBe(false);
  });
});

describe("runDocsCommand", () => {
  it("toggles character formatting from the current state", () => {
    const { api, win } = fakeEngine();
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "bold" });
    runDocsCommand(win, api, { ...INITIAL_DOCS_STATE, italic: true }, { type: "italic" });
    expect(api.put_TextPrBold).toHaveBeenCalledWith(true);
    expect(api.put_TextPrItalic).toHaveBeenCalledWith(false);
  });

  it("sets styles, fonts, sizes and alignment", () => {
    const { api, win } = fakeEngine();
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "style", name: "Heading 1" });
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "fontName", name: "Arial" });
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "fontSize", size: 400 });
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "align", align: "center" });
    expect(api.put_Style).toHaveBeenCalledWith("Heading 1");
    expect(api.put_TextPrFontName).toHaveBeenCalledWith("Arial");
    expect(api.put_TextPrFontSize).toHaveBeenCalledWith(300);
    expect(api.put_PrAlign).toHaveBeenCalledWith(2);
  });

  it("turns a list on, and off when it is already that list", () => {
    const { api, win } = fakeEngine();
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "list", list: "bullet" });
    runDocsCommand(
      win,
      api,
      { ...INITIAL_DOCS_STATE, list: "bullet" },
      { type: "list", list: "bullet" },
    );
    runDocsCommand(
      win,
      api,
      { ...INITIAL_DOCS_STATE, list: "bullet" },
      { type: "list", list: "number" },
    );
    expect(api.put_ListTypeCustom.mock.calls.map(([info]) => info)).toEqual([
      { Type: "bullet" },
      { Type: "remove" },
      { Type: "number" },
    ]);
  });

  it("builds colors with the engine's own color class", () => {
    const { api, win } = fakeEngine();
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "color", hex: "e03131" });
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "color", hex: null });
    const [red, auto] = api.put_TextColor.mock.calls.map(([color]) => color);
    expect(red).toMatchObject({ r: 224, g: 49, b: 49, auto: false });
    expect(auto).toMatchObject({ auto: true });
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "highlight", hex: "f5c518" });
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "highlight", hex: null });
    expect(api.SetMarkerFormat.mock.calls).toEqual([
      [true, true, 245, 197, 24],
      [true, false],
    ]);
  });

  it("hands dialogs to the engine's own controllers", () => {
    const { api, win, controllers, trigger } = fakeEngine();
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "link" });
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "table" });
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "imageFromUrl" });
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "comment" });
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "find" });
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "print" });
    expect(controllers.Links!.onHyperlinkClick).toHaveBeenCalled();
    expect(controllers.Toolbar!.onInsertTableClick).toHaveBeenCalledWith(null, { value: "custom" });
    expect(controllers.Toolbar!.onInsertImageClick).toHaveBeenCalledWith(null, { value: "url" });
    expect(controllers["Common.Controllers.Comments"]!.addDummyComment).toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledWith("search:show");
    expect(trigger).toHaveBeenCalledWith("file:print");
  });

  it("says which engine controller is missing instead of failing silently", () => {
    const { api, win } = fakeEngine();
    const broken = { ...win, DE: { getController: () => undefined } };
    expect(() => runDocsCommand(broken, api, INITIAL_DOCS_STATE, { type: "link" })).toThrow(
      /Links\.onHyperlinkClick/,
    );
  });

  it("shows the side bar for find & replace and the ribbon on request", () => {
    const { api, win, classes, controllers } = fakeEngine();
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "replace" });
    expect(classes.has("uno-docs-side")).toBe(true);
    expect(controllers.LeftMenu!.onShortcut).toHaveBeenCalledWith("replace");
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "fullToolbar", show: true });
    expect(classes.has("uno-docs-full")).toBe(true);
    runDocsCommand(win, api, INITIAL_DOCS_STATE, { type: "fullToolbar", show: false });
    expect(classes.has("uno-docs-full")).toBe(false);
  });
});

describe("attachDocsShell", () => {
  it("waits for the engine", () => {
    const { win } = fakeEngine();
    expect(attachDocsShell({ ...win, Asc: {} })).toBeNull();
  });

  it("hides the ribbon once, turns rulers off and reads the cursor state", () => {
    const { api, win, appended } = fakeEngine({ numberingFormat: 1 });
    const shell = attachDocsShell(win)!;
    attachDocsShell(win);
    expect(appended.filter((node) => node.id === DOCS_SHELL_STYLE_ID)).toHaveLength(1);
    expect(appended[0]!.textContent).toContain("#toolbar");
    expect(api.asc_SetViewRulers).toHaveBeenCalledWith(false);
    expect(api.UpdateInterfaceState).toHaveBeenCalled();
    expect(shell.getState()).toMatchObject({ canUndo: true, canRedo: false, list: "bullet" });
    expect(api.zoomFitToWidth).not.toHaveBeenCalled();
  });

  it("fits the page to a narrow window", () => {
    const { api, win } = fakeEngine({ width: 600 });
    attachDocsShell(win);
    expect(api.zoomFitToWidth).toHaveBeenCalled();
  });

  it("follows the engine's selection callbacks and notifies only on change", () => {
    const { win, fire } = fakeEngine();
    const shell = attachDocsShell(win)!;
    const listener = vi.fn();
    shell.subscribe(listener);
    fire("asc_onBold", true);
    fire("asc_onParaStyleName", "Heading 2");
    fire("asc_onPrAlign", 2);
    fire("asc_onFontFamily", { get_Name: () => "Georgia" });
    fire("asc_onFontSize", 14);
    fire("asc_onTextColor", {
      get_auto: () => false,
      get_r: () => 255,
      get_g: () => 0,
      get_b: () => 0,
    });
    expect(shell.getState()).toMatchObject({
      bold: true,
      style: "Heading 2",
      align: "center",
      fontName: "Georgia",
      fontSize: 14,
      color: "ff0000",
    });
    const calls = listener.mock.calls.length;
    fire("asc_onBold", true);
    expect(listener.mock.calls.length).toBe(calls);
    fire("asc_onTextColor", {
      get_auto: () => true,
      get_r: () => 0,
      get_g: () => 0,
      get_b: () => 0,
    });
    expect(shell.getState().color).toBeNull();
  });

  it("runs commands and gives the keyboard back to the text", () => {
    const { api, win, trigger } = fakeEngine();
    const shell = attachDocsShell(win)!;
    shell.run({ type: "bold" });
    expect(api.put_TextPrBold).toHaveBeenCalledWith(true);
    expect(win.focus).toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledWith("edit:complete");
    shell.run({ type: "fullToolbar", show: true });
    expect(shell.getState().fullToolbar).toBe(true);
  });

  it("offers only fonts the engine has, plus the current one", () => {
    const { win, fire } = fakeEngine();
    const withFonts = {
      ...win,
      DE: {
        getController: (name: string) =>
          name === "Toolbar"
            ? { toolbar: { cmbFontName: { store: { pluck: () => ["Arial", "Georgia", "Zapf"] } } } }
            : undefined,
      },
    };
    const shell = attachDocsShell(withFonts)!;
    expect(shell.fonts()).toEqual(["Arial", "Georgia"]);
    fire("asc_onFontFamily", { get_Name: () => "Zapf" });
    expect(shell.fonts()).toEqual(["Zapf", "Arial", "Georgia"]);
  });

  it("unsubscribes from the engine on detach", () => {
    const { win, callbacks } = fakeEngine();
    const shell = attachDocsShell(win)!;
    expect(callbacks.get("asc_onBold")).toHaveLength(1);
    shell.detach();
    expect(callbacks.get("asc_onBold")).toHaveLength(0);
  });
});

describe("officeDocsShell flag", () => {
  it("is on by default, and an explicit off in Labs is kept", () => {
    expect(resolveFeatureFlag({}, "officeDocsShell")).toBe(true);
    expect(resolveFeatureFlag({ officeDocsShell: false }, "officeDocsShell")).toBe(false);
    expect(resolveFeatureFlag({ officeDocsShell: true }, "officeDocsShell")).toBe(true);
  });
});
