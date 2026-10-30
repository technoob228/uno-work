/**
 * The page `report_publish` puts on Uno Hosting: a Markdown or HTML report
 * made readable on a phone. No scripts, no outside fonts or styles; a page
 * rendered from Markdown carries a CSP that forbids them.
 *
 * The Markdown renderer is small on purpose (no parser in the server bundle)
 * and escapes by default: raw HTML in a report shows as text, and links keep
 * only https, http and mailto. Pure: no I/O.
 *
 * @module sites/reportPage
 */

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const isSafeHref = (href: string): boolean => /^(https?:\/\/|mailto:)/i.test(href);

const INLINE =
  /(`+)([^\n]*?[^`\n])\1(?!`)|!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)|\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^*\s](?:[^*\n]*[^*\s])?)\*|(?<![\p{L}\p{N}_])_([^_\s](?:[^_\n]*[^_\s])?)_(?![\p{L}\p{N}_])|~~([^\n]+?)~~|<(https?:\/\/[^\s>]+)>|(https?:\/\/[^\s<>]+)|\\([\\`*_{}[\]()#+\-.!~|])/gu;

/** Relative images of the report, `src` to a `data:` address (see {@link reportImageRefs}). */
export type ReportImages = ReadonlyMap<string, string>;

const renderInline = (text: string, images: ReportImages): string => {
  let out = "";
  let at = 0;
  for (const match of text.matchAll(INLINE)) {
    out += escapeHtml(text.slice(at, match.index));
    at = match.index + match[0].length;
    const [
      ,
      ,
      code,
      imageAlt,
      imageSrc,
      linkLabel,
      linkHref,
      bold,
      boldAlt,
      italic,
      italicAlt,
      strike,
      autolink,
      bareUrl,
      escaped,
    ] = match;
    if (code !== undefined) {
      out += `<code>${escapeHtml(code)}</code>`;
    } else if (imageSrc !== undefined) {
      const src = /^https:\/\//i.test(imageSrc) ? imageSrc : (images.get(imageSrc) ?? null);
      out +=
        src === null
          ? escapeHtml(imageAlt ?? "")
          : `<img src="${escapeHtml(src)}" alt="${escapeHtml(imageAlt ?? "")}" loading="lazy">`;
    } else if (linkHref !== undefined) {
      const label = renderInline(linkLabel ?? "", images);
      out += isSafeHref(linkHref)
        ? `<a href="${escapeHtml(linkHref)}" rel="noopener noreferrer">${label}</a>`
        : label;
    } else if (bold !== undefined || boldAlt !== undefined) {
      out += `<strong>${renderInline(bold ?? boldAlt ?? "", images)}</strong>`;
    } else if (italic !== undefined || italicAlt !== undefined) {
      out += `<em>${renderInline(italic ?? italicAlt ?? "", images)}</em>`;
    } else if (strike !== undefined) {
      out += `<s>${renderInline(strike, images)}</s>`;
    } else if (autolink !== undefined || bareUrl !== undefined) {
      const raw = autolink ?? bareUrl ?? "";
      // Punctuation after a bare address belongs to the sentence.
      const url = raw.replace(/[.,;:!?)»]+$/u, "");
      out += `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(url)}</a>${escapeHtml(raw.slice(url.length))}`;
    } else {
      out += escapeHtml(escaped ?? "");
    }
  }
  return out + escapeHtml(text.slice(at));
};

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const MAX_DEPTH = 8;

const tableCells = (line: string): ReadonlyArray<string> =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));

const isTableStart = (lines: ReadonlyArray<string>, index: number): boolean => {
  const header = lines[index];
  const divider = lines[index + 1];
  return (
    header !== undefined &&
    divider !== undefined &&
    header.includes("|") &&
    divider.includes("-") &&
    TABLE_DIVIDER.test(divider) &&
    tableCells(header).length === tableCells(divider).length
  );
};

const startsBlock = (lines: ReadonlyArray<string>, index: number): boolean => {
  const line = lines[index] ?? "";
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    isTableStart(lines, index)
  );
};

const renderList = (
  lines: ReadonlyArray<string>,
  start: number,
  images: ReportImages,
  depth: number,
): { readonly html: string; readonly next: number } => {
  const first = LIST_ITEM.exec(lines[start] ?? "");
  const indent = first?.[1]?.length ?? 0;
  const ordered = /\d/.test(first?.[2] ?? "");
  const items: Array<string> = [];
  let index = start;
  while (index < lines.length) {
    const item = LIST_ITEM.exec(lines[index] ?? "");
    if (item === null || (item[1]?.length ?? 0) < indent) break;
    if (/\d/.test(item[2] ?? "") !== ordered && (item[1]?.length ?? 0) === indent) break;
    index += 1;
    const body: Array<string> = [item[3] ?? ""];
    // The item's own lines and everything indented under it.
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line.trim().length === 0) {
        const after = lines[index + 1] ?? "";
        if (after.trim().length === 0 || !/^\s/.test(after)) break;
        body.push("");
        index += 1;
        continue;
      }
      if (LIST_ITEM.exec(line) !== null && (LIST_ITEM.exec(line)?.[1]?.length ?? 0) <= indent) {
        break;
      }
      if (!/^\s/.test(line) && startsBlock(lines, index)) break;
      body.push(line.replace(new RegExp(`^\\s{0,${indent + 4}}`), ""));
      index += 1;
    }
    const task = /^\[( |x|X)\]\s+/.exec(body[0] ?? "");
    if (task !== null) body[0] = (body[0] ?? "").slice(task[0].length);
    const mark = task === null ? "" : task[1] === " " ? "☐ " : "☑ ";
    const inner = renderBlocks(body, images, depth + 1);
    // One short line reads as a line, not as a paragraph.
    const tight = /^<p>([\s\S]*?)<\/p>/.exec(inner);
    items.push(
      `<li>${mark}${tight === null ? inner : `${tight[1]}${inner.slice(tight[0].length)}`}</li>`,
    );
    // A blank line between items keeps the list going.
    if ((lines[index] ?? "").trim().length === 0 && LIST_ITEM.test(lines[index + 1] ?? "")) {
      const next = LIST_ITEM.exec(lines[index + 1] ?? "");
      if ((next?.[1]?.length ?? 0) >= indent) index += 1;
    }
  }
  const tag = ordered ? "ol" : "ul";
  return { html: `<${tag}>${items.join("")}</${tag}>`, next: index };
};

const renderBlocks = (
  lines: ReadonlyArray<string>,
  images: ReportImages,
  depth: number,
): string => {
  if (depth > MAX_DEPTH) return `<p>${escapeHtml(lines.join(" "))}</p>`;
  const out: Array<string> = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? "```";
      const code: Array<string> = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (current.trim().startsWith(marker) && current.trim().replaceAll(marker[0]!, "") === "") {
          index += 1;
          break;
        }
        code.push(current);
        index += 1;
      }
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      out.push(`<h${level}>${renderInline(heading[2] ?? "", images)}</h${level}>`);
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      out.push("<hr>");
      index += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: Array<string> = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(QUOTE, ""));
        index += 1;
      }
      out.push(`<blockquote>${renderBlocks(quoted, images, depth + 1)}</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const list = renderList(lines, index, images, depth);
      out.push(list.html);
      // Always moves on: a line that can't join the list becomes a paragraph.
      index = Math.max(list.next, index + 1);
      continue;
    }
    if (isTableStart(lines, index)) {
      const align = tableCells(lines[index + 1] ?? "").map((cell) =>
        cell.startsWith(":") && cell.endsWith(":")
          ? "center"
          : cell.endsWith(":")
            ? "right"
            : "left",
      );
      const cell = (tag: "th" | "td", text: string, column: number): string =>
        `<${tag}${align[column] === "left" || align[column] === undefined ? "" : ` style="text-align:${align[column]}"`}>${renderInline(text, images)}</${tag}>`;
      const head = tableCells(line)
        .map((text, column) => cell("th", text, column))
        .join("");
      const rows: Array<string> = [];
      index += 2;
      while (index < lines.length) {
        const row = lines[index] ?? "";
        if (row.trim().length === 0 || !row.includes("|")) break;
        rows.push(
          `<tr>${tableCells(row)
            .map((text, column) => cell("td", text, column))
            .join("")}</tr>`,
        );
        index += 1;
      }
      out.push(
        `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`,
      );
      continue;
    }
    const paragraph: Array<string> = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? "";
      if (next.trim().length === 0 || startsBlock(lines, index)) break;
      paragraph.push(next.trim());
      index += 1;
    }
    out.push(`<p>${paragraph.map((part) => renderInline(part, images)).join("<br>")}</p>`);
  }
  return out.join("\n");
};

/** Markdown to the page's body. Everything that isn't Markdown is escaped. */
export const renderReportMarkdown = (markdown: string, images: ReportImages = new Map()): string =>
  renderBlocks(markdown.replace(/\r\n?/g, "\n").split("\n"), images, 0);

/** The report's relative images, to inline: the page has no folder to take them from. */
export const reportImageRefs = (markdown: string): ReadonlyArray<string> => {
  const refs = new Set<string>();
  for (const match of markdown.matchAll(/!\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g)) {
    const src = match[1] ?? "";
    if (src.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(src)) refs.add(src);
  }
  return [...refs];
};

const PAGE_CSS = `:root{color-scheme:light dark;--text:#1c1c1e;--muted:#6b6b70;--line:#e3e3e6;--soft:#f5f5f7;--link:#0a66d6}
@media(prefers-color-scheme:dark){:root{--text:#ececee;--muted:#9c9ca3;--line:#34343a;--soft:#222226;--link:#6db0ff}}
*{box-sizing:border-box}
body{margin:0;padding:24px 18px 48px;background:Canvas;color:var(--text);font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-text-size-adjust:100%;overflow-wrap:anywhere}
main{max-width:42rem;margin:0 auto}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 1rem}
h2{font-size:1.3rem;line-height:1.3;margin:2rem 0 .6rem}
h3,h4,h5,h6{font-size:1.05rem;line-height:1.35;margin:1.5rem 0 .4rem}
p,ul,ol,blockquote,pre,.table{margin:0 0 1rem}
ul,ol{padding-left:1.4rem}
li{margin:.25rem 0}
li>ul,li>ol{margin:.25rem 0}
a{color:var(--link)}
hr{border:0;border-top:1px solid var(--line);margin:1.75rem 0}
img{max-width:100%;height:auto;border-radius:6px}
blockquote{padding-left:.9rem;border-left:3px solid var(--line);color:var(--muted)}
code{font:.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--soft);padding:.1em .3em;border-radius:4px}
pre{background:var(--soft);padding:12px 14px;border-radius:8px;overflow-x:auto}
pre code{background:none;padding:0;overflow-wrap:normal}
.table{overflow-x:auto}
table{border-collapse:collapse;font-size:.92rem;min-width:100%}
th,td{border-bottom:1px solid var(--line);padding:.45rem .6rem;text-align:left;vertical-align:top;overflow-wrap:normal}
th{font-weight:600;white-space:nowrap}
`;

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:";

const hasCyrillic = (text: string): boolean => /[Ѐ-ӿ]/.test(text);

const reportShell = (input: { readonly title: string; readonly body: string }): string => {
  const lang = hasCyrillic(input.title + input.body.slice(0, 4_000)) ? "ru" : "en";
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}">
<meta name="robots" content="noindex">
<title>${escapeHtml(input.title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main>
${input.body}
</main>
</body>
</html>
`;
};

const firstHeading = (markdown: string): string | null => {
  const inFence: Array<string> = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      if (inFence.length > 0) inFence.pop();
      else inFence.push(line);
      continue;
    }
    if (inFence.length > 0) continue;
    const heading = HEADING.exec(line);
    if (heading !== null) return (heading[1]?.length ?? 0) === 1 ? (heading[2] ?? null) : null;
    if (line.trim().length > 0) return null;
  }
  return null;
};

const plainTitle = (text: string): string =>
  text
    .replace(/[`*_~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();

/** A page of a Markdown (or plain text) report: the file's own heading, else `title`. */
export const reportPageFromMarkdown = (input: {
  readonly markdown: string;
  readonly title: string;
  readonly images?: ReportImages;
}): { readonly html: string; readonly title: string } => {
  const heading = firstHeading(input.markdown);
  const title = plainTitle(heading ?? input.title) || input.title;
  const body = renderReportMarkdown(input.markdown, input.images);
  return {
    title,
    html: reportShell({
      title,
      body: heading === null ? `<h1>${escapeHtml(title)}</h1>\n${body}` : body,
    }),
  };
};

const HTML_DOCUMENT = /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s|<html[\s>])/i;

/**
 * A page of an HTML report: a whole document goes up as the chat made it
 * (with a phone viewport when it has none), a fragment gets the page around it.
 */
export const reportPageFromHtml = (input: {
  readonly html: string;
  readonly title: string;
}): { readonly html: string; readonly title: string } => {
  const ownTitle = /<title[^>]*>([^<]*)<\/title>/i.exec(input.html)?.[1]?.trim();
  const title = ownTitle || input.title;
  if (!HTML_DOCUMENT.test(input.html)) {
    return { title, html: reportShell({ title, body: input.html }) };
  }
  if (/<meta[^>]+name=["']?viewport/i.test(input.html)) return { title, html: input.html };
  const viewport = `<meta name="viewport" content="width=device-width,initial-scale=1">`;
  const html = /<head[^>]*>/i.test(input.html)
    ? input.html.replace(/<head[^>]*>/i, (head) => `${head}\n${viewport}`)
    : input.html.replace(/<html[^>]*>/i, (html) => `${html}\n<head>${viewport}</head>`);
  return { title, html };
};
