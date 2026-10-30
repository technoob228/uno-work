/**
 * Getting the agent's HTML ready to live in the chat: rules a page must keep,
 * local images turned into data URIs so it survives their deletion, the file
 * in the attachments folder. Upstream's `apps/server/src/htmlRender/HtmlRender.ts`
 * with its Effect service and MCP session bookkeeping taken out: here the
 * caller is a `uno-work` tool (`unoWork/htmlTools.ts`), and paths go through
 * the caller's own rules (`~`, its folder, an assistant's boundary).
 *
 * Daemon code, outside any agent sandbox: every local file read here is
 * checked with `allowRead`, and only bytes that really are an image get in, so
 * a renamed `.env` can't be lifted into a page.
 */
import { promises as fsp } from "node:fs";
import nodePath from "node:path";

import { FILESYSTEM_READ_FILE_HARD_MAX_BYTES } from "@t3tools/contracts";
import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { createAttachmentId } from "../attachmentStore.ts";

const MIB = 1024 * 1024;
export const HTML_RENDER_MAX_IMAGE_BYTES = 10 * MIB;
/** The socket read that brings the page to the app has this ceiling too. */
export const HTML_RENDER_MAX_PAGE_BYTES = FILESYSTEM_READ_FILE_HARD_MAX_BYTES;
const formatMib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

/** A page that can't be shown; the message is for the agent. */
export class HtmlRenderProblem extends Error {
  override readonly name = "HtmlRenderProblem";
}

// Check only stylesheets and style attributes, even inside scripts; skip comments whole.
// Consume unclosed comments, tags, or quotes through EOF to keep both patterns linear.
const CSS_SOURCE =
  /<!--[\s\S]*?(?:-->|$)|<style\b[^>]*(?:>|$)([\s\S]*?)(?:<\/style\s*>|$)|\sstyle\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s>]+))/gi;
// The lookbehind skips base64 runs, such as an inlined image that happens to contain "1vh".
const VIEWPORT_HEIGHT_UNIT = /(?<![\w.+/])(?:\d+(?:\.\d+)?|\.\d+)[sld]?vh(?![\w-])/i;

/** The frame grows with the page, so a size that follows the frame would grow without end. */
export function rejectViewportHeight(html: string): void {
  for (const [, sheet, doubleQuoted, singleQuoted, unquoted] of html.matchAll(CSS_SOURCE)) {
    const css = sheet ?? doubleQuoted ?? singleQuoted ?? unquoted ?? "";
    const found = VIEWPORT_HEIGHT_UNIT.exec(css)?.[0];
    if (found !== undefined) {
      throw new HtmlRenderProblem(
        `The page uses a viewport height unit (${found}). The frame grows to fit the page, so a size that follows the viewport makes it grow again and again. Let content set the height, or use fixed pixel heights.`,
      );
    }
  }
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join("|");
const ABSOLUTE_PATH = String.raw`(?:file:///|~/|/(?!/)|[a-z]:[\\/])`;
const QUOTED_ABSOLUTE = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1`,
  "gid",
);
const CSS_URL_ABSOLUTE = new RegExp(
  String.raw`url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  "gid",
);
// `<img src="charts/q3.png">`, `url(./q3.png)`: next to the page or the chat's folder.
const RELATIVE_NAME = String.raw`(?![a-z][a-z0-9+.-]*:|/|~|#)[^"'\x60()<>\r\n]{1,2048}?\.(?:${IMAGE_EXTENSIONS})`;
const SRC_RELATIVE = new RegExp(String.raw`\ssrc\s*=\s*(["'])(${RELATIVE_NAME})\1`, "gid");
const CSS_URL_RELATIVE = new RegExp(
  String.raw`url\(\s*(["']?)(${RELATIVE_NAME})\1\s*\)`,
  "gid",
);

interface ImageReference {
  readonly start: number;
  readonly end: number;
  /** As written in the page. */
  readonly reference: string;
}

/** Where a page refers to a file on this computer. Exported for tests. */
export function findLocalImages(html: string): ReadonlyArray<ImageReference> {
  const found: ImageReference[] = [];
  const collect = (pattern: RegExp, group: number) => {
    for (const match of html.matchAll(pattern)) {
      const span = match.indices?.[group];
      if (span) found.push({ start: span[0], end: span[1], reference: html.slice(...span) });
    }
  };
  collect(QUOTED_ABSOLUTE, 2);
  collect(CSS_URL_ABSOLUTE, 1);
  collect(SRC_RELATIVE, 2);
  collect(CSS_URL_RELATIVE, 2);
  found.sort((left, right) => left.start - right.start);
  return found.filter((entry, index) => index === 0 || entry.start >= found[index - 1]!.end);
}

const decodeWithin = (reference: string): string => {
  // Inside a JS string literal a Windows path's backslashes are escaped.
  const unescaped = /^[a-z]:/i.test(reference) ? reference.replaceAll("\\\\", "\\") : reference;
  if (!unescaped.startsWith("file:///")) return unescaped;
  const bare = unescaped.slice("file://".length);
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
};

const dataUriPrefix = (reference: string) =>
  `data:${IMAGE_MIME_TYPES[reference.slice(reference.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream"};base64,`;

const latin1 = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

const after = (text: string, token: string, from: number) => {
  const at = text.indexOf(token, from);
  return at === -1 ? -1 : at + token.length;
};

const afterDoctype = (text: string, from: number) => {
  let inSubset = false;
  let at = from;
  while (at !== -1 && at < text.length) {
    const char = text[at];
    if (char === '"' || char === "'") at = after(text, char, at + 1);
    else if (inSubset && text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (inSubset && text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (char === ">" && !inSubset) return at + 1;
    else {
      if (char === "[") inSubset = true;
      else if (char === "]") inSubset = false;
      at += 1;
    }
  }
  return -1;
};

const hasSvgRoot = (text: string) => {
  let at = 0;
  while (at !== -1) {
    while (/\s/.test(text.charAt(at))) at += 1;
    if (text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (text.slice(at, at + 9).toLowerCase() === "<!doctype") at = afterDoctype(text, at + 9);
    // XML names are case-sensitive, and only these characters can end one here.
    else return /^<svg[ \t\r\n/>]/.test(text.slice(at, at + 5));
  }
  return false;
};

// Validate bytes, not filenames, so renamed files or symlinks cannot inline secrets.
export function isImageBytes(bytes: Uint8Array): boolean {
  const head = latin1(bytes, 0, 12);
  if (
    head.startsWith("\x89PNG") ||
    head.startsWith("\xff\xd8\xff") ||
    head.startsWith("GIF8") ||
    head.startsWith("\0\0\x01\0") ||
    (head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
    /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  ) {
    return true;
  }
  return hasSvgRoot(new TextDecoder().decode(bytes.subarray(0, 4096)));
}

export interface HtmlRenderFiles {
  /** A path as the agent wrote it → absolute (`~`, relative to the page or the chat's folder). */
  readonly resolve: (reference: string) => string;
  /** Why this file may not be read (an assistant's boundary); null: it may. */
  readonly denied: (absolute: string) => string | null;
}

interface ReadImage {
  readonly reference: string;
  readonly dataUri: string;
}

const readImage = async (
  reference: string,
  files: HtmlRenderFiles,
): Promise<ReadImage | { readonly refused: string } | null> => {
  const absolute = files.resolve(decodeWithin(reference));
  // The real file: a symlink out of the boundary is outside it.
  const real = await fsp.realpath(absolute).catch(() => null);
  if (real === null) return null;
  const denied = files.denied(real);
  if (denied !== null) return { refused: denied };
  const handle = await fsp.open(real, "r").catch(() => null);
  if (handle === null) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    if (info.size > HTML_RENDER_MAX_IMAGE_BYTES) {
      throw new HtmlRenderProblem(
        `${reference} is ${formatMib(info.size)}; each local image must be at most ${formatMib(HTML_RENDER_MAX_IMAGE_BYTES)}.`,
      );
    }
    // The file may grow after stat: never read past the limit.
    const buffer = Buffer.alloc(HTML_RENDER_MAX_IMAGE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > HTML_RENDER_MAX_IMAGE_BYTES) {
      throw new HtmlRenderProblem(
        `${reference} is bigger than ${formatMib(HTML_RENDER_MAX_IMAGE_BYTES)}, the limit for a local image.`,
      );
    }
    const bytes = buffer.subarray(0, bytesRead);
    if (!isImageBytes(bytes)) return null;
    return { reference, dataUri: `${dataUriPrefix(reference)}${bytes.toString("base64")}` };
  } finally {
    await handle.close().catch(() => undefined);
  }
};

export async function inlineLocalImages(
  html: string,
  files: HtmlRenderFiles,
): Promise<{ readonly html: string; readonly missing: ReadonlyArray<string> }> {
  const references = findLocalImages(html);
  if (references.length === 0) return { html, missing: [] };
  const unique = [...new Set(references.map((entry) => entry.reference))];
  const dataUris = new Map<string, string>();
  const missing: string[] = [];
  let total = Buffer.byteLength(html);
  // One at a time: a page with many pictures shouldn't hold them all in memory
  // past the limit.
  for (const reference of unique) {
    const image = await readImage(reference, files);
    if (image === null) {
      missing.push(reference);
      continue;
    }
    if ("refused" in image) throw new HtmlRenderProblem(image.refused);
    total += image.dataUri.length;
    if (total > HTML_RENDER_MAX_PAGE_BYTES) {
      throw new HtmlRenderProblem(
        `With its images inlined the page is over ${formatMib(HTML_RENDER_MAX_PAGE_BYTES)}, the limit. Use smaller images.`,
      );
    }
    dataUris.set(image.reference, image.dataUri);
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const entry of references) {
    const dataUri = dataUris.get(entry.reference);
    if (dataUri === undefined) continue;
    parts.push(html.slice(cursor, entry.start), dataUri);
    cursor = entry.end;
  }
  parts.push(html.slice(cursor));
  const inlined = parts.join("");
  const bytes = Buffer.byteLength(inlined);
  if (bytes > HTML_RENDER_MAX_PAGE_BYTES) {
    throw new HtmlRenderProblem(
      `With its images inlined the page is ${formatMib(bytes)}; the limit is ${formatMib(HTML_RENDER_MAX_PAGE_BYTES)}. Use smaller images.`,
    );
  }
  return { html: inlined, missing };
}

/**
 * The page ready to store or to photograph. `missing`: local images that
 * couldn't be read; the bootstrap goes in first so its head scan never runs
 * over inlined image data.
 */
export async function preparePage(
  html: string,
  files: HtmlRenderFiles,
): Promise<{ readonly html: string; readonly missing: ReadonlyArray<string> }> {
  rejectViewportHeight(html);
  return inlineLocalImages(injectHtmlRenderBootstrap(html), files);
}

/** Save a finished page; it goes when its chat goes (the attachments sweep by thread id). */
export async function storePage(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly html: string;
}): Promise<{ readonly attachmentId: string; readonly path: string }> {
  const attachmentId = createAttachmentId(input.threadId);
  const filePath =
    attachmentId === null
      ? null
      : resolveAttachmentRelativePath({
          attachmentsDir: input.attachmentsDir,
          relativePath: `${attachmentId}.html`,
        });
  if (attachmentId === null || filePath === null) {
    throw new HtmlRenderProblem("This chat can't keep a page.");
  }
  await fsp.mkdir(nodePath.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  await fsp.writeFile(temp, input.html, { mode: 0o600 });
  await fsp.rename(temp, filePath);
  return { attachmentId, path: filePath };
}
