/**
 * Blank Word / Excel / PowerPoint files for "New → …" in Files.
 *
 * Before this, Files could only make a Markdown "document"; renaming it to
 * .pptx or .docx gave a text file with an office name that the editor can't
 * open (that is what "the presentation editor doesn't work" was on 395).
 *
 * - docx: the smallest valid package, built here;
 * - xlsx: SheetJS (already used by Files);
 * - pptx: the engine's own blank theme deck (one empty title slide), served
 *   by the daemon with the engine — a presentation is only editable where
 *   the engine is installed anyway.
 */
import JSZip from "jszip";

import { officeEngineBase } from "./officeEngine";

export type BlankOfficeExtension = "docx" | "xlsx" | "pptx";

const BLANK_PPTX_PATH = "vendor/sdkjs/slide/themes/src/01_blank.pptx";

const DOCX_PARTS: Record<string, string> = {
  "[Content_Types].xml":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    "</Types>",
  "_rels/.rels":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    "</Relationships>",
  "word/document.xml":
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    "<w:body><w:p/>" +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>' +
    "</w:sectPr></w:body></w:document>",
};

export async function blankDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, xml] of Object.entries(DOCX_PARTS)) zip.file(name, xml);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export async function blankXlsx(): Promise<Uint8Array> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[""]]), "Sheet1");
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

export async function blankPptx(fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  const response = await fetchImpl(`${officeEngineBase()}${BLANK_PPTX_PATH}`);
  const bytes = response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  if (!bytes || !isZipArchive(bytes)) {
    throw new Error("Install Office on this computer first to make presentations.");
  }
  return bytes;
}

export function blankOfficeFile(extension: BlankOfficeExtension): Promise<Uint8Array> {
  if (extension === "docx") return blankDocx();
  if (extension === "xlsx") return blankXlsx();
  return blankPptx();
}

/** The blank kind for a file name, if it names a Word/Excel/PowerPoint file. */
export function blankExtensionFor(name: string): BlankOfficeExtension | null {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext === "docx" || ext === "xlsx" || ext === "pptx" ? ext : null;
}

/** OOXML/ODF documents are zip archives ("PK\x03\x04"). */
export function isZipArchive(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}
