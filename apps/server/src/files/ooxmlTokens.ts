/**
 * A flat XML tokenizer for OOXML parts. Not a general XML parser: it splits a
 * part into tags and text so a document can be scanned and rewritten token by
 * token while everything it doesn't touch stays byte-for-byte as it was.
 *
 * DOCTYPE (entity declarations) is refused — OOXML never has one, and it's
 * the classic way to blow up an XML reader.
 *
 * @module files/ooxmlTokens
 */

export type XmlTokenKind = "open" | "close" | "empty" | "text" | "other";

export interface XmlToken {
  readonly kind: XmlTokenKind;
  /** Qualified element name (`w:p`) for tags; "" for text/other. */
  readonly name: string;
  readonly raw: string;
}

export class XmlShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlShapeError";
  }
}

const TOKEN_RE =
  /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE|<\/?[^\s/>!?]+(?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>|[^<]+/gy;

export function tokenizeXml(xml: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let at = 0;
  while (at < xml.length) {
    TOKEN_RE.lastIndex = at;
    const match = TOKEN_RE.exec(xml);
    if (!match || match.index !== at) throw new XmlShapeError("malformed XML");
    const raw = match[0];
    at += raw.length;
    if (raw === "<!DOCTYPE") throw new XmlShapeError("DOCTYPE isn't allowed");
    if (raw[0] !== "<") {
      tokens.push({ kind: "text", name: "", raw });
    } else if (raw.startsWith("<![CDATA[")) {
      tokens.push({ kind: "text", name: "", raw });
    } else if (raw.startsWith("<!--") || raw.startsWith("<?")) {
      tokens.push({ kind: "other", name: "", raw });
    } else if (raw.startsWith("</")) {
      tokens.push({ kind: "close", name: raw.slice(2, -1).trim(), raw });
    } else {
      const name = /^<([^\s/>]+)/.exec(raw)![1]!;
      tokens.push({ kind: raw.endsWith("/>") ? "empty" : "open", name, raw });
    }
  }
  // Tags must nest.
  const stack: string[] = [];
  for (const token of tokens) {
    if (token.kind === "open") stack.push(token.name);
    else if (token.kind === "close" && stack.pop() !== token.name) {
      throw new XmlShapeError("unbalanced XML");
    }
  }
  if (stack.length > 0) throw new XmlShapeError("unbalanced XML");
  return tokens;
}

export function tokensToXml(tokens: ReadonlyArray<XmlToken>): string {
  let out = "";
  for (const token of tokens) out += token.raw;
  return out;
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** Attributes of an open/empty tag, values decoded. */
export function tagAttributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = raw.replace(/^<[^\s/>]+/, "");
  for (const match of body.matchAll(ATTR_RE)) {
    out.set(match[1]!, decodeXmlText(match[2] ?? match[3] ?? ""));
  }
  return out;
}

export function decodeXmlText(text: string): string {
  if (text.startsWith("<![CDATA[")) return text.slice(9, -3);
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, entity: string) => {
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "amp") return "&";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const code =
      entity[1] === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1));
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

export function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/"/g, "&quot;");
}
