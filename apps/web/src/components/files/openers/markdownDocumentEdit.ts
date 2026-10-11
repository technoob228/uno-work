/**
 * Editing a markdown file as the document it reads as (Misha 11.10: "edit it
 * in the preview by default; you edit the code when you turned the code view
 * on"), the pure parts.
 *
 * The document view is the rendered markdown made editable. Turning edited
 * HTML back into markdown loses the author's style (list markers, line
 * wrapping, link definitions…), so the file is never rewritten as a whole:
 * the source is cut into its top-level blocks (a heading, a paragraph, a
 * list, a table…), and on save a block the person didn't touch keeps its
 * source bytes — only the touched ones are written anew. An untouched
 * document saves byte for byte as it was.
 */
import TurndownService from "turndown";

/** Document or code: the editor the person used last, in this browser. */
export const MARKDOWN_EDIT_MODE_KEY = "uno-work:files:markdown-edit-mode";

export type MarkdownEditMode = "document" | "code";

export function parseMarkdownEditMode(raw: string | null): MarkdownEditMode {
  return raw === "code" ? "code" : "document";
}

/** A top-level block of the source, as the document view first rendered it. */
export interface MarkdownSourceBlock {
  /** Where the block's source starts and ends (offsets in the source). */
  readonly start: number;
  readonly end: number;
  /** Its HTML at the start; while it reads the same, the block is untouched. */
  readonly html: string;
}

/** A top-level node of the document view at the moment of saving. */
export interface MarkdownEditedBlock {
  /** The source block it was rendered from; null for one the person added. */
  readonly index: number | null;
  readonly innerHtml: string;
  readonly outerHtml: string;
}

interface TurndownNode {
  readonly nodeName: string;
  readonly parentNode: TurndownNode | null;
  readonly childNodes: ArrayLike<TurndownNode>;
  readonly firstChild: TurndownNode | null;
  readonly nextSibling: TurndownNode | null;
  readonly nodeValue?: string | null;
  getAttribute?(name: string): string | null;
}

function cellAlignment(node: TurndownNode): "left" | "center" | "right" | null {
  const align = node.getAttribute?.("align") ?? "";
  const style = node.getAttribute?.("style") ?? "";
  const value = (
    align ||
    /text-align:\s*(left|center|right)/i.exec(style)?.[1] ||
    ""
  ).toLowerCase();
  return value === "left" || value === "center" || value === "right" ? value : null;
}

function tableCell(content: string, node: TurndownNode): string {
  const siblings = node.parentNode ? Array.from(node.parentNode.childNodes) : [];
  const first = siblings.find((sibling) => /^T[HD]$/.test(sibling.nodeName)) === node;
  const text = content
    .trim()
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\|/g, "\\|");
  return `${first ? "| " : " "}${text} |`;
}

function isHeadingRow(row: TurndownNode): boolean {
  const parent = row.parentNode;
  if (!parent) return false;
  if (parent.nodeName === "THEAD") return true;
  const cells = Array.from(row.childNodes).filter((cell) => /^T[HD]$/.test(cell.nodeName));
  return (
    parent.firstChild === row &&
    (parent.nodeName === "TABLE" || parent.nodeName === "TBODY") &&
    cells.length > 0 &&
    cells.every((cell) => cell.nodeName === "TH")
  );
}

const ALIGNMENT_BORDER = { left: ":--", center: ":-:", right: "--:" } as const;

let turndown: TurndownService | null = null;

function turndownService(): TurndownService {
  if (turndown) return turndown;
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    hr: "---",
  });
  // The GitHub flavour the document view renders (remark-gfm): strikethrough,
  // task lists and tables.
  service.addRule("strikethrough", {
    filter: ["del", "s"],
    replacement: (content) => `~~${content}~~`,
  });
  service.addRule("taskListCheckbox", {
    filter: (node) =>
      node.nodeName === "INPUT" &&
      node.getAttribute("type") === "checkbox" &&
      node.parentNode?.nodeName === "LI",
    replacement: (_content, node) => {
      const box = node as unknown as TurndownNode;
      const spaced = /^\s/.test(box.nextSibling?.nodeValue ?? "");
      return `${box.getAttribute?.("checked") != null ? "[x]" : "[ ]"}${spaced ? "" : " "}`;
    },
  });
  // A footnote's mark in the text; its definition is a line of the source.
  service.addRule("footnoteReference", {
    filter: (node) => node.nodeName === "A" && node.getAttribute("data-footnote-ref") != null,
    replacement: (content, node) => {
      const href = (node as unknown as TurndownNode).getAttribute?.("href") ?? "";
      const id = /^#(?:user-content-)?fn-(.+)$/.exec(href)?.[1];
      return `[^${id ? decodeURIComponent(id) : content}]`;
    },
  });
  // Turndown's own list items read "-   item"; write them the way people do.
  service.addRule("listItem", {
    filter: "li",
    replacement: (content, node, options) => {
      const item = node as unknown as TurndownNode;
      const list = item.parentNode;
      let prefix = `${options.bulletListMarker} `;
      if (list?.nodeName === "OL") {
        const items = Array.from(list.childNodes).filter((child) => child.nodeName === "LI");
        const start = Number(list.getAttribute?.("start") ?? "1");
        prefix = `${(Number.isNaN(start) ? 1 : start) + items.indexOf(item)}. `;
      }
      const body = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        .replace(/\n/gm, `\n${" ".repeat(prefix.length)}`);
      return prefix + body + (item.nextSibling && !body.endsWith("\n") ? "\n" : "");
    },
  });
  service.addRule("tableCell", {
    filter: ["th", "td"],
    replacement: (content, node) => tableCell(content, node as unknown as TurndownNode),
  });
  service.addRule("tableRow", {
    filter: "tr",
    replacement: (content, node) => {
      const row = node as unknown as TurndownNode;
      if (!isHeadingRow(row)) return `\n${content}`;
      const border = Array.from(row.childNodes)
        .filter((cell) => /^T[HD]$/.test(cell.nodeName))
        .map((cell) => {
          const alignment = cellAlignment(cell);
          return tableCell(alignment ? ALIGNMENT_BORDER[alignment] : "---", cell);
        })
        .join("");
      return `\n${content}\n${border}`;
    },
  });
  service.addRule("tableSection", {
    filter: ["thead", "tbody", "tfoot"],
    replacement: (content) => content,
  });
  service.addRule("table", {
    filter: "table",
    replacement: (content) => `\n\n${content.replace(/^\n+/, "").replace(/\n{2,}/g, "\n")}\n\n`,
  });
  turndown = service;
  return service;
}

/** One block of the document view, written as markdown. */
export function htmlBlockToMarkdown(html: string): string {
  // The browser types a space at a line's end as a non-breaking one; the file gets plain spaces.
  return turndownService()
    .turndown(html)
    .replace(/\u00a0/g, " ")
    .trim();
}

/**
 * The markdown of the edited document: untouched blocks as their source,
 * touched and added ones written anew, in the order they now stand.
 *
 * What stood between two blocks (the blank lines, and what doesn't show in
 * the document: link definitions, HTML comments) is kept as it was while the
 * blocks still stand next to each other; when a block between them is gone
 * or a new one came in, the blank lines become one and the rest is kept.
 */
export function serializeEditedMarkdown(input: {
  readonly source: string;
  readonly blocks: ReadonlyArray<MarkdownSourceBlock>;
  readonly edited: ReadonlyArray<MarkdownEditedBlock>;
}): string {
  const { source, blocks, edited } = input;
  /** What stands after source block `index` (-1: before the first one). */
  const gapAfter = (index: number): string => {
    const from = index < 0 ? 0 : (blocks[index]?.end ?? source.length);
    const to = blocks[index + 1]?.start ?? source.length;
    return source.slice(from, Math.max(from, to));
  };
  /** The part of the gaps after blocks `from`…`to - 1` that isn't blank. */
  const hiddenBetween = (from: number, to: number): string => {
    const parts: string[] = [];
    for (let index = from; index < to; index += 1) {
      const text = gapAfter(index).trim();
      if (text.length > 0) parts.push(text);
    }
    return parts.join("\n\n");
  };

  const used = new Set<number>();
  let out = "";
  // The last source block accounted for, and whether it is what stands last in `out`.
  let cursor = -1;
  let cursorIsLast = true;

  for (const block of edited) {
    const original = block.index === null ? undefined : blocks[block.index];
    const index =
      original !== undefined && block.index !== null && !used.has(block.index) ? block.index : null;
    const untouched = index !== null && original !== undefined && original.html === block.innerHtml;
    const text = untouched
      ? source.slice(original.start, original.end)
      : htmlBlockToMarkdown(block.outerHtml);
    // A block emptied out is a block deleted.
    if (!untouched && text.length === 0) continue;
    if (index !== null) used.add(index);

    if (index !== null && index > cursor) {
      if (index === cursor + 1 && cursorIsLast) {
        out += gapAfter(cursor);
      } else {
        const hidden = hiddenBetween(cursor, index);
        if (out.length > 0) out += "\n\n";
        if (hidden.length > 0) out += `${hidden}\n\n`;
      }
      cursor = index;
      cursorIsLast = true;
    } else {
      if (out.length > 0) out += "\n\n";
      cursorIsLast = false;
    }
    out += text;
  }

  if (cursor === blocks.length - 1 && cursorIsLast) {
    out += gapAfter(cursor);
  } else {
    const hidden = hiddenBetween(cursor, blocks.length);
    if (hidden.length > 0) out += `${out.length > 0 ? "\n\n" : ""}${hidden}`;
    if (out.length > 0) out += "\n";
  }
  return out;
}
