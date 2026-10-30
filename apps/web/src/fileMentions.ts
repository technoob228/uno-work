/**
 * Spotting what could be a file in an agent's answer. This only proposes: the
 * computer decides (`files.resolveMentions`), so a word that merely looks like
 * a path (`and/or`, `Node.js`, `uno.place`) stays text. What is filtered out
 * here is what never is a file, so as not to ask about it.
 *
 * Agents name files every way there is: `` `~/UnoWork/report.md` ``,
 * `` `web/index.html` ``, `` `index.html` ``, a bare `reports/q3.md` in a
 * sentence, `/home/uno/x.py:12`. On real chats 2 of 3 mentions are in
 * backticks, which is why inline code counts, as a whole: `` `cat foo.md` `` is
 * a command, not a file.
 */
import { isNumberRatio } from "./markdown-links";

export interface FileMention {
  /** What the computer is asked about: the path without line and column. */
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  /**
   * Sure enough to be drawn as a chip before the computer answers, so the
   * text doesn't jump when it does. Bare names wait for the answer.
   */
  readonly strong: boolean;
}

export interface FileMentionInText extends FileMention {
  /** The mention as written. */
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const MAX_MENTION_LENGTH = 400;

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const OTHER_SCHEME = /^(?:mailto|tel|data|javascript):/i;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const POSITION_SUFFIX = /:(\d+)(?::(\d+))?$/;
const LINE_ANCHOR = /#L(\d+)(?:C(\d+))?$/i;
const VERSION = /^v?\d+(?:\.\d+)+(?:[-+][\w.-]*)?$/i;
const HOST_PORT = /^[\p{L}\p{N}.-]+:\d+(?:\/|$)/u;
const IP_ADDRESS = /^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d+)?$/;
/** Globs, placeholders and shell: `web/*.html`, `users/<id>/`, `$HOME/x`. */
const NOT_A_PATH_CHARS = /[*?<>{}|$&;=!"'`^\\]/;
const ELLIPSIS = /\.{3}|…/;
const CLI_FLAG = /\s-{1,2}[A-Za-z]/;
/** Names of any script; no spaces. A leading dot is a dotfile. */
const SEGMENT = /^[\p{L}\p{M}\p{N}._@+()[\]#%,~-]+$/u;
const SEGMENT_WITH_SPACES = /^[\p{L}\p{M}\p{N}._@+()[\]#%,~ -]+$/u;
const FILE_NAME_WITH_EXTENSION = /^.*[^.]\.[\p{L}_][\p{L}\p{N}_-]{0,14}$/u;
const DOTFILE = /^\.[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*$/u;

/** Files with no extension that are worth a chip in inline code. */
const EXTENSIONLESS_FILE_NAMES = new Set([
  "Makefile",
  "makefile",
  "GNUmakefile",
  "Dockerfile",
  "Containerfile",
  "Justfile",
  "justfile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Brewfile",
  "Caddyfile",
  "Vagrantfile",
  "Jenkinsfile",
  "Podfile",
  "LICENSE",
  "LICENCE",
  "COPYING",
  "NOTICE",
  "AUTHORS",
  "CONTRIBUTORS",
  "CHANGELOG",
  "README",
  "CODEOWNERS",
]);

const HOST_ENDINGS = new Set([
  "com",
  "net",
  "org",
  "io",
  "dev",
  "ai",
  "co",
  "edu",
  "gov",
  "info",
  "biz",
  "xyz",
  "me",
  "tv",
  "gg",
  "cloud",
  "site",
  "online",
  "tech",
  "store",
  "link",
  "place",
  "ru",
  "uk",
  "de",
  "fr",
  "nl",
  "eu",
  "us",
]);

/** What a bare word in a sentence must end with to be asked about. */
const TEXT_FILE_EXTENSIONS = new Set(
  `md markdown mdx txt rtf log csv tsv json jsonl yaml yml toml ini cfg conf env xml html htm css scss
  less js cjs mjs jsx ts tsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh fish sql
  graphql vue svelte pdf doc docx xls xlsx ppt pptx key pages numbers png jpg jpeg gif webp svg avif
  ico mp3 wav m4a mp4 mov webm zip tar gz tgz 7z ipynb lock`.split(/\s+/),
);

function lastSegment(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function fileUrlPath(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "file:") return null;
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}

function splitPosition(raw: string): { path: string; line?: number; column?: number } {
  const anchor = raw.match(LINE_ANCHOR);
  const position = anchor ?? raw.match(POSITION_SUFFIX);
  if (!position?.[1]) return { path: raw };
  const line = Number.parseInt(position[1], 10);
  const column = position[2] ? Number.parseInt(position[2], 10) : undefined;
  return {
    path: raw.slice(0, position.index),
    line,
    ...(column !== undefined ? { column } : {}),
  };
}

function looksLikeHost(path: string): boolean {
  const first = path.split("/")[0] ?? "";
  if (first === "localhost") return true;
  if (IP_ADDRESS.test(first)) return true;
  if (!first.includes(".") || first.startsWith(".")) return false;
  const ending = first.slice(first.lastIndexOf(".") + 1).toLowerCase();
  return HOST_ENDINGS.has(ending);
}

function isRooted(path: string): boolean {
  return (
    path.startsWith("/") ||
    path === "~" ||
    path.startsWith("~/") ||
    path.startsWith("./") ||
    path.startsWith("../") ||
    WINDOWS_DRIVE.test(path)
  );
}

function segmentsAreNames(path: string, pattern: RegExp): boolean {
  const body = path.replace(/^~\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return body.length > 0 && body.split("/").every((segment) => pattern.test(segment));
}

function hasFileExtension(name: string): boolean {
  return FILE_NAME_WITH_EXTENSION.test(name);
}

/** Paths whose top folder is a folder of a computer, not an API route. */
function isMachinePath(path: string): boolean {
  return /^(?:~\/|\/(?:Users|home|root|tmp|var|etc|opt|mnt|srv|Volumes|private|workspace)\/)/.test(
    path,
  );
}

function isStrong(path: string): boolean {
  if (!hasFileExtension(lastSegment(path))) return false;
  if (path.startsWith("/")) return isMachinePath(path);
  return path.includes("/");
}

function normalizeRelative(path: string): string {
  return path.replace(/^(?:\.\/)+/, "./");
}

function mentionOf(raw: string, context: "code" | "text"): FileMention | null {
  const value = raw.trim();
  if (value.length < 2 || value.length > MAX_MENTION_LENGTH) return null;
  if (URL_SCHEME.test(value) && !value.toLowerCase().startsWith("file://")) return null;
  if (OTHER_SCHEME.test(value)) return null;

  const fromUrl = value.toLowerCase().startsWith("file://") ? fileUrlPath(value) : null;
  if (value.toLowerCase().startsWith("file://") && fromUrl === null) return null;
  const { path: rawPath, line, column } = splitPosition(fromUrl ?? value);
  const windows = WINDOWS_DRIVE.test(rawPath);
  const path = windows ? rawPath : normalizeRelative(rawPath);
  const position = {
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };

  if (windows) {
    return /[*?<>|"]/.test(path) ? null : { path, ...position, strong: true };
  }
  if (path === "~" || path === "/" || path === "." || path === "..") return null;
  if (NOT_A_PATH_CHARS.test(path) || ELLIPSIS.test(path) || path.includes("//")) return null;
  if (VERSION.test(path) || isNumberRatio(path)) return null;
  if (HOST_PORT.test(path) || looksLikeHost(path)) return null;

  const rooted = isRooted(path);
  const hasSpaces = /\s/.test(path);
  if (hasSpaces && (context === "text" || !rooted || CLI_FLAG.test(path))) return null;
  if (!segmentsAreNames(path, hasSpaces ? SEGMENT_WITH_SPACES : SEGMENT)) return null;

  const name = lastSegment(path);
  const hasSlash = path.includes("/");
  // `@scope/package` and `@agent` are names, not places.
  if (path.startsWith("@") && !hasFileExtension(name)) return null;

  if (context === "text") {
    if (rooted) {
      const depth = path.split("/").filter(Boolean).length;
      if (path.startsWith("/") && depth < 2 && !hasFileExtension(name)) return null;
    } else if (hasSlash) {
      if (!hasFileExtension(name)) return null;
    } else {
      const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
      if (!name.includes(".") || !TEXT_FILE_EXTENSIONS.has(extension)) return null;
    }
  } else if (!rooted && !hasSlash) {
    if (!hasFileExtension(name) && !DOTFILE.test(name) && !EXTENSIONLESS_FILE_NAMES.has(name)) {
      return null;
    }
  }

  return { path, ...position, strong: isStrong(path) };
}

/** Inline code is a mention as a whole or not at all. */
export function fileMentionInCode(code: string): FileMention | null {
  return mentionOf(code, "code");
}

/** The address of a Markdown link, when it points at a file (`file://…` too). */
export function fileMentionInHref(href: string): FileMention | null {
  const mention = mentionOf(href, "code");
  return mention ? { ...mention, strong: true } : null;
}

const WORD = /\S+/gu;
const OPENING = /^[([{«“‘"'—–-]+/u;
const CLOSING = /[)\]}»”’"'.,;:!?…—–]+$/u;

/** Every mention in a run of plain text, in order. */
export function fileMentionsInText(text: string): FileMentionInText[] {
  const found: FileMentionInText[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    const opening = word.match(OPENING)?.[0].length ?? 0;
    const body = word.slice(opening);
    const inner = body.replace(CLOSING, "");
    if (inner.length === 0) continue;
    const mention = mentionOf(inner, "text");
    if (!mention) continue;
    const start = (match.index ?? 0) + opening;
    found.push({ ...mention, text: inner, start, end: start + inner.length });
  }
  return found;
}
