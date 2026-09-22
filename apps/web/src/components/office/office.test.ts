import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import { base64ToBytes, bytesToBase64 } from "./officeBytes";
import { isOfficeFile, officeDocumentType, officeSaveTarget } from "./officeFormats";
import { normalizeXlsxForEngine, rewriteInlineStrings } from "./normalizeXlsx";
import { splitWriteTarget, writeOfficeBytes } from "./officeSave";

describe("officeFormats", () => {
  it("maps extensions to editors", () => {
    expect(officeDocumentType("/home/u/Report.DOCX")).toBe("word");
    expect(officeDocumentType("/home/u/a.xlsx")).toBe("cell");
    expect(officeDocumentType("/home/u/deck.pptx")).toBe("slide");
    expect(isOfficeFile("/home/u/notes.md")).toBe(false);
    expect(isOfficeFile("/home/u/.xlsx")).toBe(false);
  });

  it("saves OOXML in place and legacy binaries next to the original", () => {
    expect(officeSaveTarget("/d/a.docx")).toEqual({ extension: "docx", path: "/d/a.docx" });
    expect(officeSaveTarget("/d/old.xls")).toEqual({ extension: "xlsx", path: "/d/old.xlsx" });
    expect(officeSaveTarget("/d/talk.ppt")).toEqual({ extension: "pptx", path: "/d/talk.pptx" });
    expect(officeSaveTarget("/d/a.txt")).toBeNull();
  });
});

describe("normalizeXlsx", () => {
  it("rewrites simple inline strings to t=str", () => {
    const xml =
      '<row r="1"><c r="A1" s="1" t="inlineStr"><is><t>Region</t></is></c><c r="B1" t="inlineStr"><is><t xml:space="preserve"> Q1 &amp; Q2</t></is></c><c r="C1" t="inlineStr"><is><t/></is></c><c r="D1" t="n"><v>1</v></c></row>';
    expect(rewriteInlineStrings(xml)).toBe(
      '<row r="1"><c r="A1" s="1" t="str"><v>Region</v></c><c r="B1" t="str"><v> Q1 &amp; Q2</v></c><c r="C1" t="str"><v></v></c><c r="D1" t="n"><v>1</v></c></row>',
    );
  });

  it("leaves rich-text inline strings alone", () => {
    const xml = '<c r="A1" t="inlineStr"><is><r><t>bold</t></r></is></c>';
    expect(rewriteInlineStrings(xml)).toBe(xml);
  });

  it("only touches worksheets and returns the same bytes when nothing changes", async () => {
    const zip = new JSZip();
    zip.file("xl/worksheets/sheet1.xml", '<c r="A1" t="inlineStr"><is><t>a</t></is></c>');
    zip.file("xl/sharedStrings.xml", '<c t="inlineStr"><is><t>keep</t></is></c>');
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const out = await JSZip.loadAsync(await normalizeXlsxForEngine(bytes));
    expect(await out.file("xl/worksheets/sheet1.xml")!.async("string")).toBe(
      '<c r="A1" t="str"><v>a</v></c>',
    );
    expect(await out.file("xl/sharedStrings.xml")!.async("string")).toContain("inlineStr");

    const clean = new JSZip();
    clean.file("xl/worksheets/sheet1.xml", '<c r="A1" t="s"><v>0</v></c>');
    const cleanBytes = await clean.generateAsync({ type: "uint8array" });
    expect(await normalizeXlsxForEngine(cleanBytes)).toBe(cleanBytes);
  });

  it("passes through non-zip input", async () => {
    const junk = new Uint8Array([1, 2, 3]);
    expect(await normalizeXlsxForEngine(junk)).toBe(junk);
  });
});

describe("officeSave", () => {
  it("splits absolute paths", () => {
    expect(splitWriteTarget("/home/u/docs/a.docx")).toEqual({
      cwd: "/home/u/docs",
      relativePath: "a.docx",
    });
    expect(splitWriteTarget("/a.docx")).toEqual({ cwd: "/", relativePath: "a.docx" });
    expect(splitWriteTarget("a.docx")).toBeNull();
  });

  it("writes one replace then appends, reassembling to the same bytes", async () => {
    const bytes = new Uint8Array(10_000).map((_, i) => (i * 7) % 256);
    const writeFile = vi.fn(async (_input: { contents: string; mode?: "append" }) => undefined);
    await writeOfficeBytes(writeFile, "/d/a.xlsx", bytes, 4096);
    expect(writeFile).toHaveBeenCalledTimes(3);
    expect(writeFile.mock.calls.map(([input]) => input.mode)).toEqual([
      undefined,
      "append",
      "append",
    ]);
    const joined: number[] = [];
    for (const [input] of writeFile.mock.calls) joined.push(...base64ToBytes(input.contents));
    expect(new Uint8Array(joined)).toEqual(bytes);
  });

  it("writes an empty document as a single replace", async () => {
    const writeFile = vi.fn(async () => undefined);
    await writeOfficeBytes(writeFile, "/d/a.docx", new Uint8Array());
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("round-trips base64", () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });
});
