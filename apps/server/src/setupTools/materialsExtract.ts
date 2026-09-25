/**
 * Text out of the person's material, for "Give it your material": plain text
 * formats directly, Office/OpenDocument packages by unzipping and stripping
 * the XML (the daemon's own zip reader, `files/zipPackage.ts`), PDFs through
 * `pdftotext` when the machine has it, links fetched through the SSRF guard.
 * Images and archives aren't read, only named / listed.
 *
 * Everything is bounded: 200 KB of any text file, 50 MB of an Office file,
 * 1 MB of a web page, and at most `MATERIAL_TEXT_MAX_CHARS` of text per item
 * go on to the model.
 *
 * @module setupTools/materialsExtract
 */
import fsPromises from "node:fs/promises";
import nodePath from "node:path";

import { readZip, ZipFormatError } from "../files/zipPackage.ts";
import { runProcess } from "../processRunner.ts";
import { guardedFetch, readLimited, type HostLookup } from "./netGuard.ts";

/** ~12k tokens at ~4 characters a token. */
export const MATERIAL_TEXT_MAX_CHARS = 48_000;
export const TEXT_FILE_MAX_BYTES = 200 * 1024;
export const OFFICE_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const LINK_MAX_BYTES = 1024 * 1024;
const ZIP_LIST_MAX_ENTRIES = 200;

export type ExtractState = "read" | "skipped" | "failed";

export interface Extracted {
  readonly state: ExtractState;
  /** What goes to the model; null when nothing was read. */
  readonly text: string | null;
  /** Shown next to the item: "image", "first 200 KB", why it was skipped… */
  readonly note: string | null;
}

export interface ExtractDeps {
  /** Runs a command; rejects with "Command not found" when it isn't installed. */
  readonly run?: typeof runProcess;
  readonly fetch?: typeof fetch;
  readonly lookup?: HostLookup;
  readonly linkTimeoutMs?: number;
}

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".text",
  ".csv",
  ".tsv",
  ".json",
  ".yaml",
  ".yml",
]);
const MARKUP_EXTENSIONS = new Set([".html", ".htm", ".xml", ".svg"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods"]);
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
  ".bmp",
  ".tif",
  ".tiff",
  ".avif",
]);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function tidy(text: string): string {
  return text
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Visible text of an HTML page: no scripts, styles or tags; blocks become lines. */
export function htmlToText(html: string): string {
  const withoutHidden = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|head|title)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const body = withoutHidden
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(
      /<\/(p|div|section|article|li|tr|h[1-6]|header|footer|blockquote|pre|table)\s*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ");
  const text = tidy(decodeEntities(body));
  const cleanTitle = title ? tidy(decodeEntities(title.replace(/<[^>]+>/g, " "))) : "";
  return cleanTitle && !text.startsWith(cleanTitle) ? `${cleanTitle}\n\n${text}` : text;
}

/** Text of an XML part: paragraph-ish closing tags become line breaks. */
export function xmlToText(xml: string, paragraphTags: ReadonlyArray<string> = []): string {
  let text = xml;
  for (const tag of paragraphTags) {
    text = text.replace(new RegExp(`</${tag.replace(":", "\\:")}>`, "g"), "\n");
  }
  text = text.replace(/<(w:tab|w:br|text:tab|text:line-break|a:br)\b[^>]*\/>/g, " ");
  return tidy(decodeEntities(text.replace(/<[^>]+>/g, " ")));
}

function cap(text: string): { text: string; capped: boolean } {
  return text.length > MATERIAL_TEXT_MAX_CHARS
    ? { text: text.slice(0, MATERIAL_TEXT_MAX_CHARS), capped: true }
    : { text, capped: false };
}

function result(text: string, note: string | null = null): Extracted {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { state: "skipped", text: null, note: "no text in it" };
  const capped = cap(trimmed);
  return {
    state: "read",
    text: capped.text,
    note: capped.capped ? [note, "read the beginning"].filter(Boolean).join(", ") : note,
  };
}

const decodeUtf8 = (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes);

async function readHead(filePath: string, maxBytes: number) {
  const handle = await fsPromises.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return { bytes: new Uint8Array(buffer), truncated: size > maxBytes };
  } finally {
    await handle.close();
  }
}

function slideNumber(name: string): number {
  return Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

/** Text of a .docx / .pptx / .xlsx / .odt / .odp / .ods package. */
export function officeText(extension: string, bytes: Uint8Array): string {
  const decode = (data: Uint8Array) => decodeUtf8(data);
  switch (extension) {
    case ".docx": {
      const parts = readZip(bytes, {
        include: (name) =>
          name === "word/document.xml" ||
          /^word\/(footnotes|endnotes)\.xml$/.test(name) ||
          /^word\/(header|footer)\d*\.xml$/.test(name),
      });
      const ordered = parts.toSorted((a, b) =>
        a.name === "word/document.xml" ? -1 : b.name === "word/document.xml" ? 1 : 0,
      );
      return ordered.map((part) => xmlToText(decode(part.data), ["w:p"])).join("\n\n");
    }
    case ".pptx": {
      const slides = readZip(bytes, {
        include: (name) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(name),
      });
      const text = (kind: string) =>
        slides
          .filter((part) => part.name.includes(kind))
          .toSorted((a, b) => slideNumber(a.name) - slideNumber(b.name))
          .map(
            (part) => `Slide ${slideNumber(part.name)}: ${xmlToText(decode(part.data), ["a:p"])}`,
          );
      const notes = text("notesSlide");
      return [
        ...text("slides/slide"),
        ...(notes.length > 0 ? ["Speaker notes:", ...notes] : []),
      ].join("\n\n");
    }
    case ".xlsx": {
      const parts = readZip(bytes, {
        include: (name) => name === "xl/workbook.xml" || name === "xl/sharedStrings.xml",
      });
      const workbook = parts.find((part) => part.name === "xl/workbook.xml");
      const strings = parts.find((part) => part.name === "xl/sharedStrings.xml");
      const sheets = workbook
        ? [...decode(workbook.data).matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((match) =>
            decodeEntities(match[1]!),
          )
        : [];
      const cells = strings ? xmlToText(decode(strings.data), ["si"]) : "";
      return [sheets.length > 0 ? `Sheets: ${sheets.join(", ")}` : "", cells]
        .filter(Boolean)
        .join("\n\n");
    }
    default: {
      // OpenDocument: everything is in content.xml.
      const [content] = readZip(bytes, { include: (name) => name === "content.xml" });
      return content
        ? xmlToText(decode(content.data), ["text:p", "text:h", "table:table-row"])
        : "";
    }
  }
}

/**
 * Names in a zip, from its central directory only (read from the end of the
 * file), so a huge archive costs a few KB of reading.
 */
export async function listZipEntryNames(filePath: string): Promise<{
  readonly names: ReadonlyArray<string>;
  readonly total: number;
}> {
  const handle = await fsPromises.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 22 + 0xffff);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipFormatError("not a zip archive");
    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdOffset + cdSize > size) {
      throw new ZipFormatError("zip64 isn't supported");
    }
    const directory = Buffer.alloc(Math.min(cdSize, 8 * 1024 * 1024));
    await handle.read(directory, 0, directory.length, cdOffset);
    const names: string[] = [];
    let p = 0;
    for (let n = 0; n < total && p + 46 <= directory.length; n += 1) {
      if (directory.readUInt32LE(p) !== 0x02014b50) break;
      const nameLength = directory.readUInt16LE(p + 28);
      const extraLength = directory.readUInt16LE(p + 30);
      const commentLength = directory.readUInt16LE(p + 32);
      const name = directory.subarray(p + 46, p + 46 + nameLength).toString("utf8");
      p += 46 + nameLength + extraLength + commentLength;
      if (name.endsWith("/") || name.startsWith("__MACOSX/")) continue;
      if (names.length < ZIP_LIST_MAX_ENTRIES) names.push(name);
    }
    return { names, total };
  } finally {
    await handle.close();
  }
}

function isCommandMissing(cause: unknown): boolean {
  return cause instanceof Error && /Command not found/i.test(cause.message);
}

export async function extractFile(filePath: string, deps: ExtractDeps = {}): Promise<Extracted> {
  const extension = nodePath.extname(filePath).toLowerCase();
  try {
    if (TEXT_EXTENSIONS.has(extension) || MARKUP_EXTENSIONS.has(extension)) {
      const { bytes, truncated } = await readHead(filePath, TEXT_FILE_MAX_BYTES);
      const raw = decodeUtf8(bytes);
      const text =
        extension === ".html" || extension === ".htm"
          ? htmlToText(raw)
          : MARKUP_EXTENSIONS.has(extension)
            ? xmlToText(raw)
            : raw;
      return result(text, truncated ? "read the first 200 KB" : null);
    }
    if (OFFICE_EXTENSIONS.has(extension)) {
      const { size } = await fsPromises.stat(filePath);
      if (size > OFFICE_FILE_MAX_BYTES) {
        return { state: "skipped", text: null, note: "bigger than 50 MB" };
      }
      const bytes = new Uint8Array(await fsPromises.readFile(filePath));
      return result(officeText(extension, bytes));
    }
    if (extension === ".pdf") {
      const run = deps.run ?? runProcess;
      try {
        const output = await run("pdftotext", ["-q", "-l", "60", "-enc", "UTF-8", filePath, "-"], {
          timeoutMs: 30_000,
          maxBufferBytes: 4 * 1024 * 1024,
          outputMode: "truncate",
          allowNonZeroExit: true,
        });
        if (output.timedOut)
          return { state: "failed", text: null, note: "the PDF took too long to read" };
        if (output.code !== 0 && output.stdout.trim().length === 0) {
          return { state: "failed", text: null, note: "couldn't read this PDF" };
        }
        const text = output.stdout.trim();
        if (text.length === 0) {
          return { state: "skipped", text: null, note: "scanned PDF, no text layer" };
        }
        return result(text);
      } catch (cause) {
        if (isCommandMissing(cause)) {
          return {
            state: "skipped",
            text: null,
            note: "PDF reader (pdftotext) isn't installed on this computer",
          };
        }
        throw cause;
      }
    }
    if (IMAGE_EXTENSIONS.has(extension)) {
      return { state: "read", text: null, note: "image" };
    }
    if (extension === ".zip") {
      const { names, total } = await listZipEntryNames(filePath);
      const listing = `Archive with ${total} entries:\n${names.join("\n")}${
        total > names.length ? `\n… and ${total - names.length} more` : ""
      }`;
      return { state: "read", text: listing, note: `archive, ${total} entries (not unpacked)` };
    }
    return {
      state: "skipped",
      text: null,
      note: extension ? `can't read ${extension} files yet` : "unknown file type",
    };
  } catch (cause) {
    const note =
      cause instanceof ZipFormatError
        ? `damaged or unusual file (${cause.message})`
        : cause instanceof Error
          ? cause.message
          : String(cause);
    return { state: "failed", text: null, note };
  }
}

/** A link: fetched (10 s, ≤ 1 MB, public http(s) only), HTML reduced to its text. */
export async function extractLink(link: string, deps: ExtractDeps = {}): Promise<Extracted> {
  try {
    const response = await guardedFetch(
      link,
      {
        method: "GET",
        headers: {
          accept: "text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5",
          "user-agent": "UnoWork/1.0 (+https://uno4.dev)",
        },
        signal: AbortSignal.timeout(deps.linkTimeoutMs ?? 10_000),
      },
      {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.lookup ? { lookup: deps.lookup } : {}),
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {
        state: "failed",
        text: null,
        note:
          response.status === 401 || response.status === 403
            ? "the page needs a sign-in"
            : `the site answered ${response.status}`,
      };
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (
      contentType.length > 0 &&
      !/^(text\/|application\/(json|xml|xhtml\+xml|ld\+json|rss\+xml|atom\+xml))/.test(contentType)
    ) {
      await response.body?.cancel().catch(() => undefined);
      return {
        state: "skipped",
        text: null,
        note: `not a web page (${contentType.split(";")[0]}); download it into materials/ instead`,
      };
    }
    const { bytes, truncated } = await readLimited(response, LINK_MAX_BYTES);
    const raw = decodeUtf8(bytes);
    const text =
      contentType.includes("html") || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw;
    return result(text, truncated ? "read the first 1 MB" : null);
  } catch (cause) {
    const message =
      cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")
        ? "the page didn't load in 10 seconds"
        : cause instanceof Error && cause.name === "NetGuardError"
          ? cause.message
          : "couldn't open the page";
    return { state: "failed", text: null, note: message };
  }
}
