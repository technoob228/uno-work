import { describe, expect, it } from "vitest";

import {
  parseDelimitedRows,
  serializeDelimitedRows,
  spreadsheetColumnLabel,
} from "./previewFileUtils";

describe("previewFileUtils", () => {
  it("round-trips quoted CSV fields through parse + serialize", () => {
    const source = 'name,note\nAlice,"line1\nline2"\nBob,"say ""hi"", ok"\n';
    const rows = parseDelimitedRows(source, ",");
    expect(rows).toEqual([
      ["name", "note"],
      ["Alice", "line1\nline2"],
      ["Bob", 'say "hi", ok'],
    ]);
    expect(parseDelimitedRows(serializeDelimitedRows(rows, ","), ",")).toEqual(rows);
  });

  it("serializes TSV with tab delimiter and quotes only when needed", () => {
    const rows = [
      ["a", "b"],
      ["plain", "with\ttab"],
    ];
    expect(serializeDelimitedRows(rows, "\t")).toBe('a\tb\nplain\t"with\ttab"\n');
  });

  it("labels spreadsheet columns like Excel", () => {
    expect(spreadsheetColumnLabel(0)).toBe("A");
    expect(spreadsheetColumnLabel(25)).toBe("Z");
    expect(spreadsheetColumnLabel(26)).toBe("AA");
    expect(spreadsheetColumnLabel(26 + 26 * 26 - 1)).toBe("ZZ");
  });
});
