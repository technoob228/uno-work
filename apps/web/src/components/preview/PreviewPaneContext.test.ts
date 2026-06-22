import { describe, expect, it } from "vitest";

import {
  applyProjectPreviewPatch,
  DEFAULT_PROJECT_PREVIEW_STATE,
  detectFileKind,
  DUAL_VIEW_KINDS,
  getProjectPreviewState,
  NO_PROJECT_KEY,
  toggleSourceViewIds,
  type PreviewFile,
  type ProjectPreviewState,
} from "./PreviewPaneContext";

const fileA: PreviewFile = { id: "a", name: "a.md", kind: "md", content: "# A" };
const fileB: PreviewFile = { id: "b", name: "b.md", kind: "md", content: "# B" };
const fileC: PreviewFile = { id: "c", name: "c.md", kind: "md", content: "# C" };

describe("getProjectPreviewState", () => {
  it("returns the default state for an unknown project key", () => {
    const result = getProjectPreviewState({}, "project-x");
    expect(result).toBe(DEFAULT_PROJECT_PREVIEW_STATE);
    expect(result.open).toBe(false);
    expect(result.files).toEqual([]);
  });

  it("returns the stored state when present", () => {
    const stored: ProjectPreviewState = {
      ...DEFAULT_PROJECT_PREVIEW_STATE,
      open: true,
      files: [fileA],
      activeFileId: "a",
    };
    const result = getProjectPreviewState({ "project-a": stored }, "project-a");
    expect(result).toBe(stored);
  });

  it("treats NO_PROJECT_KEY as a regular bucket", () => {
    const stored: ProjectPreviewState = {
      ...DEFAULT_PROJECT_PREVIEW_STATE,
      open: true,
      files: [fileA],
      activeFileId: "a",
    };
    expect(getProjectPreviewState({ [NO_PROJECT_KEY]: stored }, NO_PROJECT_KEY)).toBe(stored);
  });
});

describe("applyProjectPreviewPatch", () => {
  it("creates a new entry when the project key is unknown", () => {
    const next = applyProjectPreviewPatch({}, "project-a", {
      open: true,
      files: [fileA],
      activeFileId: "a",
    });
    expect(next["project-a"]).toEqual({
      ...DEFAULT_PROJECT_PREVIEW_STATE,
      open: true,
      files: [fileA],
      activeFileId: "a",
    });
  });

  it("merges into the existing entry without touching other projects", () => {
    const initial: Record<string, ProjectPreviewState> = {
      "project-a": {
        ...DEFAULT_PROJECT_PREVIEW_STATE,
        open: true,
        files: [fileA],
        activeFileId: "a",
      },
      "project-b": {
        ...DEFAULT_PROJECT_PREVIEW_STATE,
        open: true,
        files: [fileB],
        activeFileId: "b",
      },
    };
    const next = applyProjectPreviewPatch(initial, "project-a", { activeFileId: null });
    expect(next["project-a"]?.activeFileId).toBeNull();
    expect(next["project-a"]?.files).toEqual([fileA]);
    expect(next["project-b"]).toBe(initial["project-b"]);
  });

  it("isolates per-project switching: A keeps state when B is touched", () => {
    let states: Record<string, ProjectPreviewState> = {};

    states = applyProjectPreviewPatch(states, "A", {
      open: true,
      files: [fileA, fileB],
      activeFileId: "b",
    });
    states = applyProjectPreviewPatch(states, "B", {
      open: true,
      files: [fileC],
      activeFileId: "c",
    });

    const stateA = getProjectPreviewState(states, "A");
    const stateB = getProjectPreviewState(states, "B");
    expect(stateA.files).toEqual([fileA, fileB]);
    expect(stateA.activeFileId).toBe("b");
    expect(stateB.files).toEqual([fileC]);
    expect(stateB.activeFileId).toBe("c");
  });

  it("returns a fresh default for projects that have never been touched", () => {
    const states = applyProjectPreviewPatch({}, "A", {
      open: true,
      files: [fileA],
      activeFileId: "a",
    });
    const stateB = getProjectPreviewState(states, "B");
    expect(stateB).toBe(DEFAULT_PROJECT_PREVIEW_STATE);
    expect(stateB.open).toBe(false);
    expect(stateB.files).toEqual([]);
  });
});

describe("toggleSourceViewIds", () => {
  it("adds an id that is not present", () => {
    expect(toggleSourceViewIds([], "a")).toEqual(["a"]);
    expect(toggleSourceViewIds(["a"], "b")).toEqual(["a", "b"]);
  });

  it("removes an id that is present", () => {
    expect(toggleSourceViewIds(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleSourceViewIds(["a"], "a")).toEqual([]);
  });
});

describe("DUAL_VIEW_KINDS", () => {
  it("covers formats with both a rendered preview and meaningful source", () => {
    expect(DUAL_VIEW_KINDS.has("md")).toBe(true);
    expect(DUAL_VIEW_KINDS.has("html")).toBe(true);
    expect(DUAL_VIEW_KINDS.has("svg")).toBe(true);
    expect(DUAL_VIEW_KINDS.has("csv")).toBe(true);
    expect(DUAL_VIEW_KINDS.has("json")).toBe(true);
    expect(DUAL_VIEW_KINDS.has("text")).toBe(false);
    expect(DUAL_VIEW_KINDS.has("image")).toBe(false);
  });
});

describe("detectFileKind", () => {
  it("detects markdown variants", () => {
    expect(detectFileKind("readme.md")).toBe("md");
    expect(detectFileKind("README.MARKDOWN")).toBe("md");
  });

  it("detects html, pdf, json, csv/tsv, xlsx", () => {
    expect(detectFileKind("page.html")).toBe("html");
    expect(detectFileKind("page.HTM")).toBe("html");
    expect(detectFileKind("doc.pdf")).toBe("pdf");
    expect(detectFileKind("data.json")).toBe("json");
    expect(detectFileKind("data.csv")).toBe("csv");
    expect(detectFileKind("data.tsv")).toBe("csv");
    expect(detectFileKind("sheet.xlsx")).toBe("xlsx");
    expect(detectFileKind("sheet.xls")).toBe("xlsx");
  });

  it("detects docx as its own kind, not text", () => {
    expect(detectFileKind("doc.docx")).toBe("docx");
    expect(detectFileKind("DOC.DOCX")).toBe("docx");
  });

  it("detects svg as its own kind, not text", () => {
    expect(detectFileKind("logo.svg")).toBe("svg");
    expect(detectFileKind("Logo.SVG")).toBe("svg");
  });

  it("detects raster images", () => {
    expect(detectFileKind("a.png")).toBe("image");
    expect(detectFileKind("a.JPG")).toBe("image");
    expect(detectFileKind("a.jpeg")).toBe("image");
    expect(detectFileKind("a.gif")).toBe("image");
    expect(detectFileKind("a.webp")).toBe("image");
  });

  it("treats plain text and source files as text", () => {
    expect(detectFileKind("notes.txt")).toBe("text");
    expect(detectFileKind("server.log")).toBe("text");
    expect(detectFileKind("index.ts")).toBe("text");
    expect(detectFileKind("style.css")).toBe("text");
    expect(detectFileKind("Main.kt")).toBe("text");
  });

  it("returns 'unknown' for unrecognised extensions", () => {
    expect(detectFileKind("archive.zip")).toBe("unknown");
    expect(detectFileKind("noextension")).toBe("unknown");
  });
});
