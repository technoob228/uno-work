/**
 * Marks what could be a file in an answer's Markdown (fileMentions.ts) with a
 * `<file-mention>` element, around what was written. The element decides at
 * draw time, once the computer has answered: a chip, or the original text.
 * Working on the parsed tree, not the text, covers lists, tables, bold and
 * headings at once, and code blocks and links stay out of it by themselves.
 */
import { fileMentionInCode, fileMentionsInText, type FileMention } from "../../fileMentions";
import { fileLinkParentSuffixes } from "./fileLinkLabel";

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
}

/** One answer can't send a chat to the computer for more than this. */
const MAX_MENTIONS_PER_ANSWER = 60;
/** Inside these, a path is already what it is. */
const SKIPPED_NODES = new Set(["link", "linkReference", "code", "html", "image", "definition"]);

function basename(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

function mentionNode(mention: FileMention, original: MarkdownNode): MarkdownNode {
  return {
    type: "fileMention",
    data: {
      hName: "file-mention",
      hProperties: {
        path: mention.path,
        ...(mention.line !== undefined ? { line: String(mention.line) } : {}),
        ...(mention.column !== undefined ? { column: String(mention.column) } : {}),
        ...(mention.strong ? { strong: "true" } : {}),
      },
    },
    children: [original],
  };
}

function splitText(node: MarkdownNode, budget: { left: number }): MarkdownNode[] | null {
  const value = node.value ?? "";
  if (budget.left <= 0) return null;
  const mentions = fileMentionsInText(value);
  if (mentions.length === 0) return null;
  const parts: MarkdownNode[] = [];
  let cursor = 0;
  for (const mention of mentions) {
    if (budget.left <= 0) break;
    budget.left -= 1;
    if (mention.start > cursor) {
      parts.push({ type: "text", value: value.slice(cursor, mention.start) });
    }
    parts.push(mentionNode(mention, { type: "text", value: mention.text }));
    cursor = mention.end;
  }
  if (cursor < value.length) parts.push({ type: "text", value: value.slice(cursor) });
  return parts;
}

function walk(parent: MarkdownNode, budget: { left: number }, found: string[]): void {
  const children = parent.children;
  if (!children) return;
  const next: MarkdownNode[] = [];
  for (const child of children) {
    if (SKIPPED_NODES.has(child.type)) {
      next.push(child);
    } else if (child.type === "inlineCode") {
      const mention = budget.left > 0 ? fileMentionInCode(child.value ?? "") : null;
      if (mention) {
        budget.left -= 1;
        found.push(mention.path);
        next.push(mentionNode(mention, child));
      } else {
        next.push(child);
      }
    } else if (child.type === "text") {
      const parts = splitText(child, budget);
      if (parts) {
        for (const part of parts) {
          const path = part.data?.hProperties?.path;
          if (path) found.push(path);
        }
        next.push(...parts);
      } else {
        next.push(child);
      }
    } else {
      walk(child, budget, found);
      next.push(child);
    }
  }
  parent.children = next;
}

function applyLabels(node: MarkdownNode, suffixes: ReadonlyMap<string, string>): void {
  const properties = node.data?.hProperties;
  if (node.type === "fileMention" && properties?.path) {
    const suffix = suffixes.get(properties.path);
    properties.label = suffix
      ? `${basename(properties.path)} · ${suffix}`
      : basename(properties.path);
    return;
  }
  for (const child of node.children ?? []) applyLabels(child, suffixes);
}

export function remarkFileMentions() {
  return (tree: MarkdownNode) => {
    const found: string[] = [];
    walk(tree, { left: MAX_MENTIONS_PER_ANSWER }, found);
    // A bare name may well be the same file as a full path next to it.
    applyLabels(tree, fileLinkParentSuffixes(found.filter((path) => path.includes("/"))));
  };
}
