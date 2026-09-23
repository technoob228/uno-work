/**
 * "Can comment" links, enforced on the computer.
 *
 * The editor saves a whole .docx, so the daemon can't simply check "is this
 * only a comment?" byte by byte: the in-browser engine rewrites every part of
 * the package on each save (styles, numbering, run boundaries…), even when
 * nothing but a comment was added. Instead the daemon never takes the
 * visitor's document at all. It takes the file that is on the computer and
 * copies into it only the comments from the upload:
 *
 * 1. The text of the upload's body must be exactly the text of the current
 *    file (characters, tabs, breaks, paragraph ends, one placeholder per
 *    picture/object). Otherwise the save is refused: someone changed the
 *    document through a comment link.
 * 2. Each comment marker of the upload (range start, range end, reference) is
 *    placed into the current body at the same text position, splitting a run
 *    where needed. The current file's own markers are dropped first — the
 *    upload carries every comment the visitor saw, including the old ones.
 * 3. The comment parts (comments, commentsExtended, commentsIds,
 *    commentsExtensible, people) are rebuilt from the upload keeping only the
 *    known elements/attributes and plain text, then wired in with fresh
 *    relationships and content types.
 *
 * Everything else — formatting, pictures, styles, headers, properties — is
 * the current file's, untouched. So the worst a comment link can do is add,
 * edit or delete comments.
 *
 * @module files/docxComments
 */
import {
  decodeXmlText,
  escapeXmlAttribute,
  escapeXmlText,
  tagAttributes,
  tokenizeXml,
  type XmlToken,
  XmlShapeError,
} from "./ooxmlTokens.ts";
import { readZip, writeZip, ZipFormatError, type ZipEntry } from "./zipPackage.ts";

export type CommentMergeResult =
  | { readonly kind: "merged"; readonly bytes: Uint8Array; readonly comments: number }
  | {
      readonly kind: "rejected";
      readonly reason: "text_changed" | "unsupported" | "malformed";
      readonly message: string;
    };

export const COMMENT_ONLY_MESSAGE =
  "This link can only comment. The text of the document was changed, so nothing was saved.";

const MAX_COMMENTS = 5_000;
const MAX_COMMENT_TEXT = 1024 * 1024;

const REL = {
  officeDocument:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  comments: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
  commentsExtended: "http://schemas.microsoft.com/office/2011/relationships/commentsExtended",
  commentsIds: "http://schemas.microsoft.com/office/2016/09/relationships/commentsIds",
  commentsExtensible:
    "http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible",
  people: "http://schemas.microsoft.com/office/2011/relationships/people",
} as const;

type CommentPartKind =
  | "comments"
  | "commentsExtended"
  | "commentsIds"
  | "commentsExtensible"
  | "people";
const COMMENT_PART_KINDS: ReadonlyArray<CommentPartKind> = [
  "comments",
  "commentsExtended",
  "commentsIds",
  "commentsExtensible",
  "people",
];
const CONTENT_TYPE: Record<CommentPartKind, string> = {
  comments: "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
  commentsExtended:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml",
  commentsIds: "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml",
  commentsExtensible:
    "application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtensible+xml",
  people: "application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml",
};
const PART_FILE: Record<CommentPartKind, string> = {
  comments: "comments.xml",
  commentsExtended: "commentsExtended.xml",
  commentsIds: "commentsIds.xml",
  commentsExtensible: "commentsExtensible.xml",
  people: "people.xml",
};

const NS = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  w14: "http://schemas.microsoft.com/office/word/2010/wordml",
  w15: "http://schemas.microsoft.com/office/word/2012/wordml",
  w16cid: "http://schemas.microsoft.com/office/word/2016/wordml/cid",
  w16cex: "http://schemas.microsoft.com/office/word/2018/wordml/cex",
  mc: "http://schemas.openxmlformats.org/markup-compatibility/2006",
};
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ── Body text scan ──────────────────────────────────────────────────────────

/** Elements inside a run that stand for one character of text. */
const RUN_CHARS: Record<string, string> = {
  "w:tab": "\t",
  "w:ptab": "\t",
  "w:br": "\n",
  "w:cr": "\n",
  "w:noBreakHyphen": "-",
  "w:sym": "\ufffc",
  "w:footnoteReference": "\u2020",
  "w:endnoteReference": "\u2020",
};
/** Regions whose inside isn't body text; the first three count as one character. */
const OBJECT_REGIONS = new Set(["w:drawing", "w:pict", "w:object"]);
const MATH_REGIONS = new Set(["m:oMathPara", "m:oMath"]);
const SKIP_REGIONS = new Set([
  "mc:Fallback",
  "w:rPr",
  "w:pPr",
  "w:sectPr",
  "w:instrText",
  "w:delText",
  "w:tblPr",
  "w:tcPr",
  "w:trPr",
]);
const MARKERS = new Set(["w:commentRangeStart", "w:commentRangeEnd", "w:commentReference"]);

interface RunChild {
  readonly first: number;
  last: number;
  readonly start: number;
  end: number;
  /** For a `<w:t>` child: its decoded text. */
  text: string | null;
}
interface RunInfo {
  readonly open: number;
  close: number;
  readonly start: number;
  end: number;
  rPr: [number, number] | null;
  readonly children: RunChild[];
}
interface BodyMarker {
  readonly kind: "start" | "end" | "ref";
  readonly id: string;
  readonly offset: number;
}
interface BodyScan {
  readonly text: string;
  readonly runs: RunInfo[];
  /** Characters outside runs (paragraph ends, equations): token that makes them. */
  readonly paraChars: Array<{ readonly token: number; readonly offset: number }>;
  readonly markers: BodyMarker[];
  readonly lastParaEnd: number;
}

function scanBody(tokens: ReadonlyArray<XmlToken>): BodyScan {
  let text = "";
  const stack: string[] = [];
  let skipAt = -1;
  let run: RunInfo | null = null;
  let runDepth = -1;
  let child: RunChild | null = null;
  let childIsRPr = false;
  const runs: RunInfo[] = [];
  const paraChars: Array<{ token: number; offset: number }> = [];
  const markers: BodyMarker[] = [];
  let lastParaEnd = -1;

  const directChildOfRun = () => run !== null && stack.length === runDepth + 1;
  const finishChild = (index: number) => {
    if (!child || !run) return;
    child.last = index;
    child.end = text.length;
    if (childIsRPr) run.rPr = [child.first, index];
    else run.children.push(child);
    child = null;
    childIsRPr = false;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind === "open") {
      if (skipAt >= 0) {
        stack.push(token.name);
        continue;
      }
      if (directChildOfRun()) {
        child = { first: i, last: i, start: text.length, end: text.length, text: null };
        childIsRPr = token.name === "w:rPr";
      }
      if (token.name === "w:r" && run === null) {
        run = { open: i, close: i, start: text.length, end: text.length, rPr: null, children: [] };
        runDepth = stack.length;
        stack.push(token.name);
        continue;
      }
      if (OBJECT_REGIONS.has(token.name)) {
        if (run) text += "\ufffc";
        skipAt = stack.length;
      } else if (MATH_REGIONS.has(token.name)) {
        if (!run) {
          paraChars.push({ token: i, offset: text.length });
          text += "\u2211";
        }
        skipAt = stack.length;
      } else if (SKIP_REGIONS.has(token.name)) {
        skipAt = stack.length;
      } else if (MARKERS.has(token.name)) {
        // `<w:commentRangeStart …></w:commentRangeStart>` — same as the empty form.
        recordMarker(token, text.length, markers);
      }
      stack.push(token.name);
      continue;
    }
    if (token.kind === "empty") {
      if (skipAt >= 0) continue;
      const startsChild = directChildOfRun();
      if (startsChild) {
        child = { first: i, last: i, start: text.length, end: text.length, text: null };
        childIsRPr = token.name === "w:rPr";
      }
      if (run && RUN_CHARS[token.name] !== undefined) text += RUN_CHARS[token.name];
      if (token.name === "w:p") {
        // `<w:p/>` — an empty paragraph is still a paragraph end.
        paraChars.push({ token: i, offset: text.length });
        text += "\u00b6";
        lastParaEnd = i;
      }
      if (MARKERS.has(token.name)) recordMarker(token, text.length, markers);
      if (startsChild) finishChild(i);
      continue;
    }
    if (token.kind === "text") {
      if (skipAt >= 0 || !run) continue;
      if (stack.at(-1) === "w:t" && stack.length === runDepth + 2) {
        const decoded = decodeXmlText(token.raw);
        text += decoded;
        if (child) child.text = (child.text ?? "") + decoded;
      }
      continue;
    }
    if (token.kind === "close") {
      stack.pop();
      if (skipAt >= 0) {
        if (stack.length === skipAt) skipAt = -1;
        if (skipAt < 0 && run && stack.length === runDepth + 1) finishChild(i);
        continue;
      }
      if (token.name === "w:p") {
        paraChars.push({ token: i, offset: text.length });
        text += "\u00b6";
        lastParaEnd = i;
        continue;
      }
      if (run && stack.length === runDepth) {
        run.close = i;
        run.end = text.length;
        runs.push(run);
        run = null;
        runDepth = -1;
        continue;
      }
      if (run && stack.length === runDepth + 1) {
        if (child && child.text === null && tokens[child.first]!.name === "w:t") child.text = "";
        finishChild(i);
      }
    }
  }
  return { text, runs, paraChars, markers, lastParaEnd };
}

function recordMarker(token: XmlToken, offset: number, markers: BodyMarker[]) {
  const id = tagAttributes(token.raw).get("w:id");
  if (id === undefined || !/^-?\d{1,10}$/.test(id)) return;
  const kind =
    token.name === "w:commentRangeStart"
      ? "start"
      : token.name === "w:commentRangeEnd"
        ? "end"
        : "ref";
  markers.push({ kind, id, offset });
}

/** Drops every comment marker (and the runs that only held a reference) from a body. */
function stripCommentMarkers(tokens: ReadonlyArray<XmlToken>): XmlToken[] {
  const out: XmlToken[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind === "open" && token.name === "w:r") {
      const close = matchingClose(tokens, i);
      if (isReferenceOnlyRun(tokens, i, close)) {
        i = close;
        continue;
      }
    }
    if (MARKERS.has(token.name)) {
      if (token.kind === "open") i = matchingClose(tokens, i);
      continue;
    }
    out.push(token);
  }
  return out;
}

function matchingClose(tokens: ReadonlyArray<XmlToken>, open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind === "open") depth += 1;
    else if (token.kind === "close") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

/** `<w:r>[<w:rPr>…</w:rPr>]<w:commentReference/></w:r>` */
function isReferenceOnlyRun(tokens: ReadonlyArray<XmlToken>, open: number, close: number): boolean {
  let reference = false;
  for (let i = open + 1; i < close; i += 1) {
    const token = tokens[i]!;
    if (token.kind === "open" && token.name === "w:rPr") {
      i = matchingClose(tokens, i);
      continue;
    }
    if (token.kind === "empty" && token.name === "w:rPr") continue;
    if (token.kind === "text" && token.raw.trim() === "") continue;
    if (token.name === "w:commentReference") {
      reference = true;
      if (token.kind === "open") i = matchingClose(tokens, i);
      continue;
    }
    return false;
  }
  return reference;
}

// ── Placing markers ─────────────────────────────────────────────────────────

function markerXml(marker: BodyMarker): string {
  if (marker.kind === "start") return `<w:commentRangeStart w:id="${marker.id}"/>`;
  if (marker.kind === "end") return `<w:commentRangeEnd w:id="${marker.id}"/>`;
  return `<w:r><w:commentReference w:id="${marker.id}"/></w:r>`;
}

function placeMarkers(
  tokens: ReadonlyArray<XmlToken>,
  scan: BodyScan,
  markers: ReadonlyArray<BodyMarker>,
): string {
  const before = new Map<number, string>();
  const splits = new Map<RunInfo, BodyMarker[]>();
  const addBefore = (token: number, xml: string) =>
    before.set(token, (before.get(token) ?? "") + xml);

  for (const marker of markers) {
    const k = marker.offset;
    const inside = scan.runs.find((run) => run.start < k && k < run.end);
    if (inside) {
      const list = splits.get(inside) ?? [];
      list.push(marker);
      splits.set(inside, list);
      continue;
    }
    const startsHere = scan.runs.find((run) => run.start === k && run.end > k);
    if (startsHere) {
      addBefore(startsHere.open, markerXml(marker));
      continue;
    }
    const paraChar = scan.paraChars.find((entry) => entry.offset === k);
    if (paraChar) {
      addBefore(paraChar.token, markerXml(marker));
      continue;
    }
    if (scan.lastParaEnd >= 0) addBefore(scan.lastParaEnd, markerXml(marker));
  }

  const replaced = new Map<number, { readonly to: number; readonly xml: string }>();
  for (const [run, list] of splits) {
    replaced.set(run.open, { to: run.close, xml: splitRun(tokens, run, list) });
  }

  let out = "";
  for (let i = 0; i < tokens.length; i += 1) {
    const extra = before.get(i);
    const token = tokens[i]!;
    if (extra && token.kind === "empty" && token.name === "w:p") {
      // Markers go inside an empty paragraph, not next to it at body level.
      out += `${token.raw.replace(/\s*\/>$/, ">")}${extra}</w:p>`;
      continue;
    }
    if (extra) out += extra;
    const replacement = replaced.get(i);
    if (replacement) {
      out += replacement.xml;
      i = replacement.to;
      continue;
    }
    out += token.raw;
  }
  return out;
}

function splitRun(
  tokens: ReadonlyArray<XmlToken>,
  run: RunInfo,
  markers: ReadonlyArray<BodyMarker>,
): string {
  const raw = (from: number, to: number) => {
    let text = "";
    for (let i = from; i <= to; i += 1) text += tokens[i]!.raw;
    return text;
  };
  const reopen = tokens[run.open]!.raw + (run.rPr ? raw(run.rPr[0], run.rPr[1]) : "");
  const pending = [...markers];
  const breakAt = (limit: number, inclusive: boolean) => {
    let xml = "";
    while (
      pending.length > 0 &&
      (inclusive ? pending[0]!.offset <= limit : pending[0]!.offset < limit)
    ) {
      xml += markerXml(pending.shift()!);
    }
    return xml ? `</w:r>${xml}${reopen}` : "";
  };
  let out = reopen;
  for (const child of run.children) {
    out += breakAt(child.start, true);
    const isText = tokens[child.first]!.name === "w:t" && child.text !== null;
    if (isText && pending.length > 0 && pending[0]!.offset < child.end) {
      let cursor = child.start;
      let piece = "";
      for (const ch of child.text!) {
        if (pending.length > 0 && pending[0]!.offset <= cursor && cursor > child.start) {
          out += `<w:t xml:space="preserve">${escapeXmlText(piece)}</w:t>${breakAt(cursor, true)}`;
          piece = "";
        }
        piece += ch;
        cursor += ch.length;
      }
      out += `<w:t xml:space="preserve">${escapeXmlText(piece)}</w:t>`;
      continue;
    }
    out += raw(child.first, child.last);
  }
  out += breakAt(run.end, false);
  return `${out}</w:r>`;
}

// ── Packages ────────────────────────────────────────────────────────────────

interface Relationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
}

function parseRelationships(xml: string): Relationship[] {
  return tokenizeXml(xml)
    .filter(
      (token) => (token.kind === "empty" || token.kind === "open") && token.name === "Relationship",
    )
    .map((token) => {
      const attrs = tagAttributes(token.raw);
      return {
        id: attrs.get("Id") ?? "",
        type: attrs.get("Type") ?? "",
        target: attrs.get("Target") ?? "",
        external: attrs.get("TargetMode") === "External",
      };
    });
}

function relsPathFor(partName: string): string {
  const slash = partName.lastIndexOf("/");
  return `${partName.slice(0, slash + 1)}_rels/${partName.slice(slash + 1)}.rels`;
}

function resolveTarget(sourcePart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = sourcePart.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== "." && segment !== "") parts.push(segment);
  }
  return parts.join("/");
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

class Pkg {
  readonly entries: Map<string, Uint8Array>;
  readonly order: string[];
  constructor(entries: ReadonlyArray<ZipEntry>) {
    this.entries = new Map(entries.map((entry) => [entry.name, entry.data]));
    this.order = entries.map((entry) => entry.name);
  }
  text(name: string): string | null {
    const data = this.entries.get(name);
    return data ? decoder.decode(data) : null;
  }
  set(name: string, text: string) {
    if (!this.entries.has(name)) this.order.push(name);
    this.entries.set(name, encoder.encode(text));
  }
  delete(name: string) {
    this.entries.delete(name);
  }
  mainPart(): string {
    const rels = this.text("_rels/.rels");
    const main = rels
      ? parseRelationships(rels).find((rel) => rel.type === REL.officeDocument)
      : undefined;
    if (!main) throw new XmlShapeError("no main document");
    return resolveTarget("", main.target);
  }
  toBytes(): Uint8Array {
    return writeZip(
      [...new Set(this.order)]
        .filter((name) => this.entries.has(name))
        .map((name) => ({ name, data: this.entries.get(name)! })),
    );
  }
}

function commentParts(
  pkg: Pkg,
  main: string,
): Map<CommentPartKind, { rel: Relationship; part: string }> {
  const out = new Map<CommentPartKind, { rel: Relationship; part: string }>();
  const relsXml = pkg.text(relsPathFor(main));
  if (!relsXml) return out;
  for (const rel of parseRelationships(relsXml)) {
    if (rel.external) continue;
    const kind = COMMENT_PART_KINDS.find((candidate) => REL[candidate] === rel.type);
    if (kind && !out.has(kind)) out.set(kind, { rel, part: resolveTarget(main, rel.target) });
  }
  return out;
}

// ── Rebuilding the comment parts from the upload ────────────────────────────

const HEX_ID = /^[0-9A-Fa-f]{1,8}$/;

function attr(name: string, value: string | undefined): string {
  return value === undefined ? "" : ` ${name}="${escapeXmlAttribute(value)}"`;
}

/** comments.xml with plain-text paragraphs only. Returns the comment ids too. */
function rebuildComments(xml: string): { xml: string; ids: Set<string> } {
  const tokens = tokenizeXml(xml);
  const ids = new Set<string>();
  let out = "";
  let inComment = false;
  let paragraph: string | null = null;
  let inText = false;
  let textBudget = MAX_COMMENT_TEXT;
  for (const token of tokens) {
    if (token.kind === "open" && token.name === "w:comment") {
      const attrs = tagAttributes(token.raw);
      const id = attrs.get("w:id") ?? "";
      if (!/^-?\d{1,10}$/.test(id) || ids.has(id)) {
        throw new XmlShapeError("bad comment id");
      }
      if (ids.size >= MAX_COMMENTS) throw new XmlShapeError("too many comments");
      ids.add(id);
      inComment = true;
      out += `<w:comment w:id="${id}"${attr("w:author", attrs.get("w:author")?.slice(0, 200))}${attr(
        "w:date",
        attrs.get("w:date")?.slice(0, 40),
      )}${attr("w:initials", attrs.get("w:initials")?.slice(0, 20))}>`;
      continue;
    }
    if (!inComment) continue;
    if (token.kind === "close" && token.name === "w:comment") {
      if (paragraph !== null) out += `${paragraph}</w:p>`;
      paragraph = null;
      out += "</w:comment>";
      inComment = false;
      continue;
    }
    if ((token.kind === "open" || token.kind === "empty") && token.name === "w:p") {
      if (paragraph !== null) out += `${paragraph}</w:p>`;
      const attrs = tagAttributes(token.raw);
      const paraId = attrs.get("w14:paraId");
      const textId = attrs.get("w14:textId");
      paragraph = `<w:p${paraId && HEX_ID.test(paraId) ? ` w14:paraId="${paraId}"` : ""}${
        textId && HEX_ID.test(textId) ? ` w14:textId="${textId}"` : ""
      }>`;
      if (token.kind === "empty") {
        out += `${paragraph}</w:p>`;
        paragraph = null;
      }
      continue;
    }
    if (token.kind === "close" && token.name === "w:p") {
      if (paragraph !== null) out += `${paragraph}</w:p>`;
      paragraph = null;
      continue;
    }
    if (paragraph === null) continue;
    if (token.kind === "open" && token.name === "w:t") inText = true;
    else if (token.kind === "close" && token.name === "w:t") inText = false;
    else if (token.kind === "text" && inText) {
      const text = decodeXmlText(token.raw);
      textBudget -= text.length;
      if (textBudget < 0) throw new XmlShapeError("comments too long");
      paragraph += `<w:r><w:t xml:space="preserve">${escapeXmlText(text)}</w:t></w:r>`;
    } else if (token.kind === "empty" && (token.name === "w:tab" || token.name === "w:br")) {
      paragraph += `<w:r><${token.name}/></w:r>`;
    }
  }
  return {
    xml: `${XML_DECL}<w:comments xmlns:w="${NS.w}" xmlns:w14="${NS.w14}" xmlns:mc="${NS.mc}" mc:Ignorable="w14">${out}</w:comments>`,
    ids,
  };
}

interface FlatSpec {
  readonly root: string;
  readonly namespaces: Record<string, string>;
  readonly element: string;
  readonly attributes: Record<string, RegExp>;
  readonly child?: { readonly element: string; readonly attributes: Record<string, RegExp> };
}

const ANY_SHORT = /^.{0,200}$/u;
const FLAT: Record<Exclude<CommentPartKind, "comments">, FlatSpec> = {
  commentsExtended: {
    root: "w15:commentsEx",
    namespaces: { w15: NS.w15, mc: NS.mc },
    element: "w15:commentEx",
    attributes: { "w15:paraId": HEX_ID, "w15:paraIdParent": HEX_ID, "w15:done": /^[01]$/ },
  },
  commentsIds: {
    root: "w16cid:commentsIds",
    namespaces: { w16cid: NS.w16cid, mc: NS.mc },
    element: "w16cid:commentId",
    attributes: { "w16cid:paraId": HEX_ID, "w16cid:durableId": HEX_ID },
  },
  commentsExtensible: {
    root: "w16cex:commentsExtensible",
    namespaces: { w16cex: NS.w16cex, mc: NS.mc },
    element: "w16cex:commentExtensible",
    attributes: { "w16cex:durableId": HEX_ID, "w16cex:dateUtc": /^[0-9TZ:.+-]{1,40}$/ },
  },
  people: {
    root: "w15:people",
    namespaces: { w15: NS.w15, mc: NS.mc },
    element: "w15:person",
    attributes: { "w15:author": ANY_SHORT },
    child: {
      element: "w15:presenceInfo",
      attributes: { "w15:providerId": ANY_SHORT, "w15:userId": ANY_SHORT },
    },
  },
};

function keptAttributes(raw: string, allowed: Record<string, RegExp>): string {
  const attrs = tagAttributes(raw);
  let out = "";
  for (const [name, pattern] of Object.entries(allowed)) {
    const value = attrs.get(name);
    if (value !== undefined && pattern.test(value)) out += attr(name, value);
  }
  return out;
}

function rebuildFlat(xml: string, spec: FlatSpec): string {
  const tokens = tokenizeXml(xml);
  let out = "";
  let open = false;
  let count = 0;
  for (const token of tokens) {
    if ((token.kind === "open" || token.kind === "empty") && token.name === spec.element) {
      if (open) out += `</${spec.element}>`;
      count += 1;
      if (count > MAX_COMMENTS * 2) throw new XmlShapeError("too many entries");
      out += `<${spec.element}${keptAttributes(token.raw, spec.attributes)}${spec.child ? ">" : "/>"}`;
      open = Boolean(spec.child) && token.kind === "open";
      if (spec.child && token.kind === "empty") out += `</${spec.element}>`;
      continue;
    }
    if (token.kind === "close" && token.name === spec.element) {
      if (open) out += `</${spec.element}>`;
      open = false;
      continue;
    }
    if (
      open &&
      spec.child &&
      (token.kind === "empty" || token.kind === "open") &&
      token.name === spec.child.element
    ) {
      out += `<${spec.child.element}${keptAttributes(token.raw, spec.child.attributes)}/>`;
    }
  }
  if (open) out += `</${spec.element}>`;
  const ns = Object.entries(spec.namespaces)
    .map(([prefix, uri]) => ` xmlns:${prefix}="${uri}"`)
    .join("");
  const ignorable = Object.keys(spec.namespaces)
    .filter((prefix) => prefix !== "mc")
    .join(" ");
  return `${XML_DECL}<${spec.root}${ns} mc:Ignorable="${ignorable}">${out}</${spec.root}>`;
}

// ── Content types and relationships ─────────────────────────────────────────

function rewriteContentTypes(
  xml: string,
  removed: ReadonlySet<string>,
  added: ReadonlyMap<string, string>,
) {
  const tokens = tokenizeXml(xml);
  let out = "";
  for (const token of tokens) {
    if ((token.kind === "empty" || token.kind === "open") && token.name === "Override") {
      const part = (tagAttributes(token.raw).get("PartName") ?? "").replace(/^\//, "");
      if (removed.has(part) || added.has(part)) continue;
    }
    if (token.kind === "close" && token.name === "Override") continue;
    if (token.kind === "close" && token.name === "Types") {
      for (const [part, type] of added) {
        out += `<Override PartName="/${escapeXmlAttribute(part)}" ContentType="${type}"/>`;
      }
    }
    out += token.raw;
  }
  return out;
}

function rewriteRelationships(
  xml: string | null,
  removedIds: ReadonlySet<string>,
  added: ReadonlyArray<{ type: string; target: string }>,
): string {
  const source =
    xml ??
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  const tokens = tokenizeXml(source);
  const existing = new Set(parseRelationships(source).map((rel) => rel.id));
  let out = "";
  let skippingOpen = false;
  let n = 1;
  for (const token of tokens) {
    if ((token.kind === "empty" || token.kind === "open") && token.name === "Relationship") {
      const id = tagAttributes(token.raw).get("Id") ?? "";
      if (removedIds.has(id)) {
        skippingOpen = token.kind === "open";
        continue;
      }
    }
    if (skippingOpen && token.kind === "close" && token.name === "Relationship") {
      skippingOpen = false;
      continue;
    }
    if (token.kind === "close" && token.name === "Relationships") {
      for (const rel of added) {
        let id = `rIdUnoC${n}`;
        while (existing.has(id)) id = `rIdUnoC${++n}`;
        existing.add(id);
        n += 1;
        out += `<Relationship Id="${id}" Type="${rel.type}" Target="${escapeXmlAttribute(rel.target)}"/>`;
      }
    }
    out += token.raw;
  }
  return out;
}

function relativeTarget(fromPart: string, toPart: string): string {
  const fromDir = fromPart.split("/").slice(0, -1);
  const to = toPart.split("/");
  let common = 0;
  while (common < fromDir.length && common < to.length - 1 && fromDir[common] === to[common])
    common += 1;
  return [...fromDir.slice(common).map(() => ".."), ...to.slice(common)].join("/");
}

/** Other parts of the current file that anchor comments (headers, footnotes…). */
function hasMarkersOutsideBody(pkg: Pkg, main: string): boolean {
  for (const name of pkg.order) {
    if (name === main || !name.endsWith(".xml") || !name.startsWith(main.split("/")[0]!)) continue;
    const data = pkg.entries.get(name);
    if (!data || data.length > 20 * 1024 * 1024) continue;
    const text = new TextDecoder().decode(data);
    if (text.includes("w:commentRangeStart") || text.includes("w:commentReference")) return true;
  }
  return false;
}

// ── The merge ───────────────────────────────────────────────────────────────

/**
 * The current .docx with the comments of `upload` put into it, or a refusal
 * when the upload's text isn't the current text.
 */
export function mergeDocxComments(input: {
  readonly current: Uint8Array;
  readonly upload: Uint8Array;
}): CommentMergeResult {
  try {
    const current = new Pkg(readZip(input.current));
    const upload = new Pkg(readZip(input.upload));
    const main = current.mainPart();
    const uploadMain = upload.mainPart();
    const currentXml = current.text(main);
    const uploadXml = upload.text(uploadMain);
    if (currentXml === null || uploadXml === null) {
      return { kind: "rejected", reason: "malformed", message: "The document has no body." };
    }
    if (hasMarkersOutsideBody(current, main)) {
      return {
        kind: "rejected",
        reason: "unsupported",
        message:
          "This document has comments in its headers, footers or notes, which a comment link can't save yet. Ask the owner for an edit link.",
      };
    }

    const currentTokens = stripCommentMarkers(tokenizeXml(currentXml));
    const currentScan = scanBody(currentTokens);
    const uploadScan = scanBody(tokenizeXml(uploadXml));
    if (currentScan.text !== uploadScan.text) {
      return { kind: "rejected", reason: "text_changed", message: COMMENT_ONLY_MESSAGE };
    }

    // Comment parts from the upload, rebuilt.
    const uploadParts = commentParts(upload, uploadMain);
    const rebuilt = new Map<CommentPartKind, string>();
    let ids = new Set<string>();
    const commentsSource = uploadParts.get("comments");
    const commentsXml = commentsSource ? upload.text(commentsSource.part) : null;
    if (commentsXml !== null) {
      const comments = rebuildComments(commentsXml);
      ids = comments.ids;
      if (ids.size > 0) {
        rebuilt.set("comments", comments.xml);
        for (const kind of COMMENT_PART_KINDS) {
          if (kind === "comments") continue;
          const source = uploadParts.get(kind);
          const xml = source ? upload.text(source.part) : null;
          if (xml !== null) rebuilt.set(kind, rebuildFlat(xml, FLAT[kind]));
        }
      }
    }
    const markers = uploadScan.markers.filter((marker) => ids.has(marker.id));

    // Body with the upload's markers.
    current.set(main, placeMarkers(currentTokens, currentScan, markers));

    // Swap the comment parts.
    const oldParts = commentParts(current, main);
    const removedParts = new Set<string>();
    const removedRelIds = new Set<string>();
    for (const { rel, part } of oldParts.values()) {
      removedParts.add(part);
      removedRelIds.add(rel.id);
      current.delete(part);
      current.delete(relsPathFor(part));
    }
    const mainDir = main.split("/").slice(0, -1).join("/");
    const addedTypes = new Map<string, string>();
    const addedRels: Array<{ type: string; target: string }> = [];
    for (const [kind, xml] of rebuilt) {
      const part = mainDir ? `${mainDir}/${PART_FILE[kind]}` : PART_FILE[kind];
      current.delete(relsPathFor(part));
      current.set(part, xml);
      addedTypes.set(part, CONTENT_TYPE[kind]);
      addedRels.push({ type: REL[kind], target: relativeTarget(main, part) });
    }
    current.set(
      relsPathFor(main),
      rewriteRelationships(current.text(relsPathFor(main)), removedRelIds, addedRels),
    );
    const contentTypes = current.text("[Content_Types].xml");
    if (contentTypes === null) throw new XmlShapeError("no content types");
    current.set("[Content_Types].xml", rewriteContentTypes(contentTypes, removedParts, addedTypes));

    return { kind: "merged", bytes: current.toBytes(), comments: ids.size };
  } catch (error) {
    if (
      error instanceof ZipFormatError ||
      error instanceof XmlShapeError ||
      error instanceof TypeError
    ) {
      return {
        kind: "rejected",
        reason: "malformed",
        message: "That isn't a document the editor made.",
      };
    }
    throw error;
  }
}

/** The body text the check compares — exported for tests and diagnostics. */
export function docxBodyText(bytes: Uint8Array): string {
  const pkg = new Pkg(readZip(bytes));
  const xml = pkg.text(pkg.mainPart());
  if (xml === null) throw new XmlShapeError("no body");
  return scanBody(stripCommentMarkers(tokenizeXml(xml))).text;
}
