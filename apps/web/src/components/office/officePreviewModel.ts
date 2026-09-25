/**
 * A quick text preview of a docx/xlsx/pptx, shown while the editor starts.
 *
 * The engine needs a second or more to boot even when it's cached (and much
 * longer the very first time), so the page shows the document's words right
 * away instead of a spinner: headings, paragraphs, list items and tables of a
 * Word file, the first sheet of a spreadsheet, the text of the first slides.
 * No formatting, no pictures — it's replaced by the real editor as soon as the
 * document is drawn. Reads only the XML parts it needs, with limits, so a big
 * file doesn't stall the page.
 */
import JSZip from "jszip";

export type OfficePreviewBlock =
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "listItem"; readonly text: string }
  | { readonly kind: "table"; readonly rows: ReadonlyArray<ReadonlyArray<string>> }
  | { readonly kind: "slide"; readonly index: number; readonly lines: ReadonlyArray<string> };

export interface OfficePreviewModel {
  readonly blocks: ReadonlyArray<OfficePreviewBlock>;
  /** More content exists than the preview shows. */
  readonly truncated: boolean;
}

const MAX_BLOCKS = 80;
const MAX_TABLE_ROWS = 40;
const MAX_COLUMNS = 12;
const MAX_SLIDES = 8;
const MAX_PART_BYTES = 4 * 1024 * 1024;

interface XmlToken {
  /** Local tag name ("p" for `<w:p>`), or null for text. */
  readonly name: string | null;
  readonly kind: "open" | "close" | "self" | "text";
  /** Raw tag source (attributes) or decoded text. */
  readonly value: string;
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITY[entity] ?? match;
  });
}

/**
 * A tiny streaming tokenizer — enough for OOXML parts (no DTDs, no CDATA in
 * practice). No DOM needed, so it also runs in tests and workers.
 */
function* xmlTokens(xml: string): Generator<XmlToken> {
  const pattern = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|<[?!][^>]*>|([^<]+)/g;
  for (let match = pattern.exec(xml); match !== null; match = pattern.exec(xml)) {
    if (match[5] !== undefined) {
      yield { name: null, kind: "text", value: match[5] };
      continue;
    }
    if (match[2] === undefined) continue; // <?xml …?>, <!-- … -->
    const qualified = match[2];
    const name = qualified.slice(qualified.indexOf(":") + 1);
    const kind = match[1] ? "close" : match[4] ? "self" : "open";
    yield { name, kind, value: match[3] ?? "" };
  }
}

function attribute(tagSource: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}="([^"]*)"`).exec(tagSource);
  return match ? decodeXmlText(match[1] ?? "") : null;
}

async function readPart(zip: JSZip, name: string): Promise<string | null> {
  const file = zip.file(name);
  if (!file) return null;
  const text = await file.async("string");
  return text.length > MAX_PART_BYTES ? null : text;
}

function paragraphBlock(
  text: string,
  styleId: string,
  numbered: boolean,
): OfficePreviewBlock | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const style = styleId.toLowerCase();
  if (style === "title") return { kind: "heading", level: 1, text: clean };
  const heading = /^heading\s*([1-9])$/.exec(style);
  if (heading) {
    return { kind: "heading", level: Math.min(Number(heading[1]), 3) as 1 | 2 | 3, text: clean };
  }
  if (numbered || style.includes("list")) return { kind: "listItem", text: clean };
  return { kind: "paragraph", text: clean };
}

async function previewDocx(zip: JSZip): Promise<OfficePreviewModel | null> {
  const xml = await readPart(zip, "word/document.xml");
  if (!xml || !xml.includes("body>")) return null;
  const blocks: OfficePreviewBlock[] = [];
  let truncated = false;
  let paragraphDepth = 0;
  let tableDepth = 0;
  let inText = false;
  let text = "";
  let styleId = "";
  let numbered = false;
  let rows: string[][] = [];
  let row: string[] | null = null;
  let cell: string[] | null = null;

  for (const token of xmlTokens(xml)) {
    if (blocks.length >= MAX_BLOCKS) {
      truncated = true;
      break;
    }
    if (token.kind === "text") {
      if (inText && paragraphDepth > 0) text += decodeXmlText(token.value);
      continue;
    }
    const { name, kind } = token;
    if (name === "t") {
      inText = kind === "open";
    } else if (name === "tab" && kind !== "close" && paragraphDepth > 0) {
      text += "\t";
    } else if ((name === "br" || name === "cr") && kind !== "close" && paragraphDepth > 0) {
      text += " ";
    } else if (name === "pStyle" && paragraphDepth === 1) {
      styleId = attribute(token.value, "val") ?? "";
    } else if (name === "numPr" && kind !== "close" && paragraphDepth === 1) {
      numbered = true;
    } else if (name === "p") {
      if (kind === "open") {
        paragraphDepth += 1;
        if (paragraphDepth === 1) {
          text = "";
          styleId = "";
          numbered = false;
        }
      } else if (kind === "close" && paragraphDepth > 0) {
        paragraphDepth -= 1;
        if (paragraphDepth === 0) {
          if (tableDepth > 0) {
            const clean = text.replace(/\s+/g, " ").trim();
            if (cell && clean) cell.push(clean);
          } else {
            const block = paragraphBlock(text, styleId, numbered);
            if (block) blocks.push(block);
          }
        }
      }
    } else if (name === "tbl") {
      if (kind === "open") {
        tableDepth += 1;
        if (tableDepth === 1) rows = [];
      } else if (kind === "close" && tableDepth > 0) {
        tableDepth -= 1;
        if (tableDepth === 0 && rows.length > 0) blocks.push({ kind: "table", rows });
      }
    } else if (name === "tr" && tableDepth === 1) {
      if (kind === "open") row = [];
      else if (kind === "close" && row) {
        if (rows.length < MAX_TABLE_ROWS) rows.push(row.slice(0, MAX_COLUMNS));
        row = null;
      }
    } else if (name === "tc" && tableDepth === 1) {
      if (kind === "open") cell = [];
      else if (kind === "close" && cell) {
        row?.push(cell.join(" "));
        cell = null;
      }
    }
  }
  return { blocks, truncated };
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/** Text of every `<si>` (shared strings) — or of each `<a:p>` paragraph. */
function textsOf(xml: string, container: string, textTag = "t"): string[] {
  const out: string[] = [];
  let current: string | null = null;
  let inText = false;
  for (const token of xmlTokens(xml)) {
    if (token.kind === "text") {
      if (inText && current !== null) current += decodeXmlText(token.value);
    } else if (token.name === container) {
      if (token.kind === "open") current = "";
      else if (token.kind === "self") out.push("");
      else if (current !== null) {
        out.push(current);
        current = null;
      }
    } else if (token.name === textTag) {
      inText = token.kind === "open";
    }
  }
  return out;
}

async function previewXlsx(zip: JSZip): Promise<OfficePreviewModel | null> {
  const workbook = (await readPart(zip, "xl/workbook.xml")) ?? "";
  const rels = (await readPart(zip, "xl/_rels/workbook.xml.rels")) ?? "";
  const firstSheet = /<(?:\w+:)?sheet\s[^>]*>/.exec(workbook)?.[0] ?? "";
  const relId = attribute(firstSheet, "id");
  let target: string | null = null;
  for (const match of rels.matchAll(/<(?:\w+:)?Relationship\s[^>]*>/g)) {
    if (relId && attribute(match[0], "Id") === relId) target = attribute(match[0], "Target");
  }
  const sheetPath = target
    ? target.startsWith("/")
      ? target.slice(1)
      : `xl/${target.replace(/^\.\//, "")}`
    : "xl/worksheets/sheet1.xml";
  const sheet = await readPart(zip, sheetPath);
  if (!sheet) return null;
  const sharedXml = await readPart(zip, "xl/sharedStrings.xml");
  const strings = sharedXml ? textsOf(sharedXml, "si") : [];

  const rows: string[][] = [];
  let rowCount = 0;
  let row: string[] | null = null;
  let cellColumn = -1;
  let cellType: string | null = null;
  let value = "";
  let inValue = false;
  for (const token of xmlTokens(sheet)) {
    if (token.kind === "text") {
      if (inValue) value += decodeXmlText(token.value);
      continue;
    }
    if (token.name === "row") {
      if (token.kind === "open") {
        rowCount += 1;
        row = rowCount <= MAX_TABLE_ROWS ? [] : null;
      } else if (token.kind === "close" && row) {
        rows.push(Array.from(row, (entry) => entry ?? ""));
        row = null;
      }
    } else if (token.name === "c" && row) {
      if (token.kind === "open") {
        cellColumn = columnIndex(attribute(token.value, "r") ?? "");
        cellType = attribute(token.value, "t");
        value = "";
      } else if (token.kind === "close") {
        if (cellColumn >= 0 && cellColumn < MAX_COLUMNS) {
          row[cellColumn] =
            cellType === "s"
              ? (strings[Number(value)] ?? "")
              : cellType === "b"
                ? value === "1"
                  ? "TRUE"
                  : "FALSE"
                : value;
        }
        cellColumn = -1;
      }
    } else if ((token.name === "v" || token.name === "t") && row && cellColumn >= 0) {
      inValue = token.kind === "open";
    }
  }
  if (rows.length === 0) return { blocks: [], truncated: false };
  const width = Math.min(MAX_COLUMNS, Math.max(1, ...rows.map((entry) => entry.length)));
  return {
    blocks: [
      {
        kind: "table",
        rows: rows.map((entry) => Array.from({ length: width }, (_, i) => entry[i] ?? "")),
      },
    ],
    truncated: rowCount > MAX_TABLE_ROWS,
  };
}

async function previewPptx(zip: JSZip): Promise<OfficePreviewModel | null> {
  const names = Object.keys(zip.files)
    .map((name) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ name: match[0], index: Number(match[1]) }))
    .toSorted((a, b) => a.index - b.index);
  if (names.length === 0) return null;
  const blocks: OfficePreviewBlock[] = [];
  for (const { name, index } of names.slice(0, MAX_SLIDES)) {
    const slide = await readPart(zip, name);
    if (!slide) continue;
    const lines = textsOf(slide, "p")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 12);
    blocks.push({ kind: "slide", index, lines });
  }
  return { blocks, truncated: names.length > MAX_SLIDES };
}

/**
 * Builds the preview, or null when the format isn't previewable or the file
 * can't be read (the page then just shows the spinner).
 */
export async function buildOfficePreview(
  bytes: Uint8Array,
  extension: string,
): Promise<OfficePreviewModel | null> {
  const ext = extension.toLowerCase();
  if (ext !== "docx" && ext !== "xlsx" && ext !== "pptx") return null;
  try {
    const zip = await JSZip.loadAsync(bytes);
    if (ext === "docx") return await previewDocx(zip);
    if (ext === "xlsx") return await previewXlsx(zip);
    return await previewPptx(zip);
  } catch {
    return null;
  }
}
