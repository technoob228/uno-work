import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import { registerFileOpener, resolveFileOpener, type FileDescriptor } from "./fileOpeners";
import { breadcrumbs, fileKindOf, numberedCopyName } from "./fileTypes";
import { parseFilesRouteSearch } from "./filesRouteSearch";
import {
  detectUnsupportedParts,
  editKey,
  markFullCalcOnLoad,
  parseWorkbook,
  writeWorkbookWithEdits,
} from "./openers/sheetModel";

const noAppends = { rows: new Map<number, number>(), cols: new Map<number, number>() };

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("file kinds and paths", () => {
  it("maps extensions to kinds", () => {
    expect(fileKindOf("Report.DOCX")).toBe("document");
    expect(fileKindOf("budget.xlsx")).toBe("spreadsheet");
    expect(fileKindOf("deck.pptx")).toBe("presentation");
    expect(fileKindOf("site.html")).toBe("html");
    expect(fileKindOf("notes.md")).toBe("markdown");
    expect(fileKindOf("data.csv")).toBe("csv");
    expect(fileKindOf("photo.jpeg")).toBe("image");
    expect(fileKindOf("Dockerfile")).toBe("code");
    expect(fileKindOf("mystery")).toBe("other");
    expect(fileKindOf("Projects", true)).toBe("folder");
  });

  it("builds crumbs from Home down", () => {
    expect(breadcrumbs("/home/u", "/home/u")).toEqual([{ label: "Home", path: "/home/u" }]);
    expect(breadcrumbs("/home/u", "/home/u/Docs/2026")).toEqual([
      { label: "Home", path: "/home/u" },
      { label: "Docs", path: "/home/u/Docs" },
      { label: "2026", path: "/home/u/Docs/2026" },
    ]);
  });

  it("names a saved copy", () => {
    expect(numberedCopyName("Budget.xlsx")).toBe("Budget (edited).xlsx");
    expect(numberedCopyName("README")).toBe("README (edited)");
  });

  it("accepts only absolute paths in the route", () => {
    expect(parseFilesRouteSearch({ path: "/home/u", file: "/home/u/a.md" })).toEqual({
      path: "/home/u",
      file: "/home/u/a.md",
    });
    expect(parseFilesRouteSearch({ path: "relative", file: 3 })).toEqual({});
  });
});

describe("file openers", () => {
  const file = (name: string): FileDescriptor => ({
    name,
    path: `/home/u/${name}`,
    kind: fileKindOf(name),
    size: 10,
    modifiedAt: "2026-09-22T00:00:00.000Z",
  });
  const View = () => null;

  it("picks the highest score and lets a later engine take over a format", () => {
    const removeBase = registerFileOpener({ id: "t.base", label: "Base", match: () => 1, View });
    const removeDocs = registerFileOpener({
      id: "t.docs",
      label: "Docs",
      match: (entry) => (entry.kind === "document" ? 10 : 0),
      View,
    });
    expect(resolveFileOpener(file("a.docx"))?.id).toBe("t.docs");
    expect(resolveFileOpener(file("a.bin"))?.id).toBe("t.base");

    const removeOffice = registerFileOpener({
      id: "t.office",
      label: "Office",
      match: (entry) => (entry.kind === "document" ? 100 : 0),
      View,
    });
    expect(resolveFileOpener(file("a.docx"))?.id).toBe("t.office");
    removeOffice();
    expect(resolveFileOpener(file("a.docx"))?.id).toBe("t.docs");
    removeDocs();
    removeBase();
  });

  it("refuses files bigger than the opener allows", () => {
    const remove = registerFileOpener({ id: "t.small", label: "Small", match: () => 50, View, maxBytes: 5 });
    expect(resolveFileOpener(file("a.txt"))).toBeNull();
    remove();
  });
});

describe("spreadsheet model", () => {
  function makeWorkbook(): ArrayBuffer {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Item", "Price"],
      ["Coffee", 3],
      ["Tea", 2],
    ]);
    sheet["B4"] = { t: "n", f: "SUM(B2:B3)", v: 5 };
    sheet["!ref"] = "A1:B4";
    sheet["!cols"] = [{ wch: 30 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(workbook, sheet, "Budget");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["keep me"]]), "Notes");
    return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  }

  it("reads values, formulas and every sheet", async () => {
    const data = await parseWorkbook("budget.xlsx", makeWorkbook());
    expect(data.sheets.map((sheet) => sheet.name)).toEqual(["Budget", "Notes"]);
    const budget = data.sheets[0]!;
    expect(budget.cells[1]?.[0]).toEqual({ display: "Coffee", input: "Coffee" });
    expect(budget.cells[3]?.[1]).toEqual({ display: "5", input: "=SUM(B2:B3)" });
  });

  it("saves only the edited cells and keeps formulas, sheets and widths", async () => {
    const data = await parseWorkbook("budget.xlsx", makeWorkbook());
    const edits = new Map([
      [editKey(0, 1, 1), "4"],
      [editKey(0, 4, 0), "Total"],
      [editKey(0, 4, 1), "=B4*2"],
    ]);
    const bytes = await markFullCalcOnLoad(writeWorkbookWithEdits(data, edits, noAppends));
    const saved = XLSX.read(bytes, { type: "array", cellFormula: true, cellStyles: true });
    const budget = saved.Sheets["Budget"]!;
    expect(budget["B2"]?.v).toBe(4);
    expect(budget["B4"]?.f).toBe("SUM(B2:B3)");
    expect(budget["A5"]?.v).toBe("Total");
    expect(budget["B5"]?.f).toBe("B4*2");
    expect(budget["!ref"]).toBe("A1:B5");
    expect(budget["!cols"]?.[0]?.wch).toBe(30);
    expect(saved.Sheets["Notes"]?.["A1"]?.v).toBe("keep me");
    // The new formula shows as a formula until Excel computes it on open.
    const reopened = await parseWorkbook("budget.xlsx", toArrayBuffer(bytes));
    expect(reopened.sheets[0]?.cells[4]?.[1]).toEqual({ display: "=B4*2", input: "=B4*2" });
    const JSZip = (await import("jszip")).default;
    const workbookXml = await (await JSZip.loadAsync(bytes)).file("xl/workbook.xml")!.async("text");
    expect(workbookXml).toContain('fullCalcOnLoad="1"');
  });

  it("round-trips CSV with quotes, commas and new rows", async () => {
    const csv = 'name,note\n"Smith, J","said ""hi"""\n';
    const data = await parseWorkbook("people.csv", toArrayBuffer(new TextEncoder().encode(csv)));
    expect(data.sheets[0]?.cells[1]?.[0]?.display).toBe("Smith, J");
    const edits = new Map([
      [editKey(0, 2, 0), "Lee"],
      [editKey(0, 2, 1), "new"],
    ]);
    const out = new TextDecoder().decode(
      writeWorkbookWithEdits(data, edits, { rows: new Map([[0, 1]]), cols: new Map() }),
    );
    expect(out).toBe('name,note\n"Smith, J","said ""hi"""\nLee,new\n');
  });

  it("flags workbook parts the browser can't write back", () => {
    expect(
      detectUnsupportedParts([
        "xl/workbook.xml",
        "xl/charts/chart1.xml",
        "xl/media/image1.png",
        "xl/pivotTables/pivotTable1.xml",
      ]),
    ).toEqual(["charts", "pictures", "pivot tables"]);
    expect(detectUnsupportedParts(["xl/workbook.xml", "xl/worksheets/sheet1.xml"])).toEqual([]);
  });
});
