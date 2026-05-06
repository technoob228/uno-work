import { describe, expect, it } from "vitest";

import { detectFileKind } from "./PreviewPaneContext";

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
