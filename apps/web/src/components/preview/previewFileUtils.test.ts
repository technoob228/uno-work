import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { PreviewFile, PreviewFileKind } from "./PreviewPaneContext";
import {
  parseDelimitedRows,
  previewDownloadSource,
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

const tab = (kind: PreviewFileKind, extra: Partial<PreviewFile> = {}): PreviewFile => ({
  id: `tab-${kind}`,
  name: `file.${kind}`,
  kind,
  content: "",
  ...extra,
});

describe("previewDownloadSource", () => {
  const env = "env-1" as EnvironmentId;

  it("offers Download for every file kind the panel shows", () => {
    const fileKinds: PreviewFileKind[] = [
      "image",
      "pdf",
      "docx",
      "xlsx",
      "md",
      "mermaid",
      "text",
      "csv",
      "json",
      "html",
      "svg",
      "unknown",
    ];
    for (const kind of fileKinds) {
      // Opened from Files / the sidebar tree / a chat link: a path on the computer.
      expect(previewDownloadSource(tab(kind, { path: `/home/me/a.${kind}` }), env)).toEqual({
        kind: "computer",
        path: `/home/me/a.${kind}`,
        environmentId: env,
      });
    }
  });

  it("uses the tab's own computer before the chat's", () => {
    const other = "env-2" as EnvironmentId;
    expect(
      previewDownloadSource(tab("pdf", { path: "/home/me/a.pdf", environmentId: other }), env),
    ).toMatchObject({ kind: "computer", environmentId: other });
  });

  it("saves a picture pinned from a chat from its blob, a snippet from its text", () => {
    expect(previewDownloadSource(tab("image", { blobUrl: "blob:x" }), null)).toEqual({
      kind: "blob",
      blobUrl: "blob:x",
    });
    expect(previewDownloadSource(tab("md", { content: "# Hi" }), null)).toEqual({
      kind: "content",
      content: "# Hi",
    });
    // A path but no computer to read it from: the inline bytes still go.
    expect(
      previewDownloadSource(tab("image", { path: "/home/me/a.png", blobUrl: "blob:y" }), null),
    ).toEqual({ kind: "blob", blobUrl: "blob:y" });
  });

  it("has no Download on tabs that are not a file or have nothing to save", () => {
    for (const kind of ["browser", "live-browser", "plugin-panel", "app", "tasks"] as const) {
      expect(previewDownloadSource(tab(kind, { path: "/x", content: "x" }), env)).toBeNull();
    }
    expect(previewDownloadSource(tab("pdf"), env)).toBeNull();
  });
});
