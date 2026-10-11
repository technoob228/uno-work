/**
 * A markdown file edited as the document it reads as: the rendered markdown,
 * editable in place. What it writes back, and why block by block, is in
 * `markdownDocumentEdit.ts`.
 */
import {
  type ClipboardEvent,
  type Ref,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "../../../lib/utils";
import {
  type MarkdownEditedBlock,
  type MarkdownSourceBlock,
  serializeEditedMarkdown,
} from "./markdownDocumentEdit";

export interface MarkdownDocumentEditorHandle {
  /** The document as markdown, as it stands now. */
  readonly read: () => string;
}

interface SourceTreeNode {
  readonly type: string;
  readonly value?: string;
  properties?: Record<string, unknown>;
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
}

/**
 * Marks every top-level element with where its source starts and ends. Raw
 * HTML in the file (a comment, a `<details>`) reads as its text, as a block of
 * its own, so it is saved back as it was like any other block.
 */
function rehypeSourceOffsets() {
  return (tree: { children: Array<SourceTreeNode | Record<string, unknown>> }) => {
    tree.children = tree.children.map((child) => {
      const node = child as SourceTreeNode;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (typeof start !== "number" || typeof end !== "number") return node;
      if (node.type === "raw" && typeof node.value === "string") {
        return {
          type: "element",
          tagName: "div",
          properties: { dataMdStart: start, dataMdEnd: end, dataMdRaw: "" },
          children: [{ type: "text", value: node.value }],
        };
      }
      if (node.type === "element") {
        node.properties = { ...node.properties, dataMdStart: start, dataMdEnd: end };
      }
      return node;
    });
  };
}

/**
 * Rendered once per source: after that the DOM belongs to the person typing
 * in it, and React must not touch it again.
 */
const FrozenDocument = memo(function FrozenDocument({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSourceOffsets]}>
      {markdown}
    </ReactMarkdown>
  );
});

/** The node's HTML with what lives only in properties (a ticked checkbox) written out. */
function serializableHtml(element: HTMLElement): string {
  const boxes = element.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  if (boxes.length === 0) return element.outerHTML;
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box, index) => {
    if (boxes[index]?.checked) box.setAttribute("checked", "");
    else box.removeAttribute("checked");
  });
  return clone.outerHTML;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Pasted text comes in plain: the styles and markup of another page don't belong in the file.
function pastePlainText(event: ClipboardEvent<HTMLDivElement>) {
  event.preventDefault();
  const text = event.clipboardData.getData("text/plain");
  if (text.length > 0) document.execCommand("insertText", false, text);
}

export function MarkdownDocumentEditor(props: {
  /** The source the document is rendered from; to render another, remount (`key`). */
  readonly markdown: string;
  readonly onInput: () => void;
  readonly autoFocus?: boolean;
  readonly className?: string;
  readonly label: string;
  readonly ref?: Ref<MarkdownDocumentEditorHandle>;
}) {
  const { markdown } = props;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const blocksRef = useRef<ReadonlyArray<MarkdownSourceBlock>>([]);

  // Before the person can type: remember each block's source and how it reads now.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const blocks: MarkdownSourceBlock[] = [];
    for (const child of Array.from(root.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const start = Number(child.dataset.mdStart);
      const end = Number(child.dataset.mdEnd);
      if (child.dataset.mdStart === undefined || Number.isNaN(start) || Number.isNaN(end)) {
        // Made by the renderer (the footnotes list): its source lives elsewhere.
        child.dataset.mdGenerated = "";
        continue;
      }
      child.dataset.mdBlock = String(blocks.length);
      blocks.push({ start, end, html: child.innerHTML });
    }
    blocksRef.current = blocks;
    // An empty document still needs a line to type on.
    if (root.children.length === 0) {
      const line = document.createElement("p");
      line.append(document.createElement("br"));
      root.append(line);
    }
    if (props.autoFocus) root.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown]);

  const read = useCallback((): string => {
    const root = rootRef.current;
    if (!root) return markdown;
    const edited: MarkdownEditedBlock[] = [];
    for (const node of Array.from(root.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        if (text.trim().length > 0) {
          edited.push({ index: null, innerHtml: "", outerHtml: `<p>${escapeHtml(text)}</p>` });
        }
        continue;
      }
      if (!(node instanceof HTMLElement) || node.dataset.mdGenerated !== undefined) continue;
      const index = node.dataset.mdBlock === undefined ? null : Number(node.dataset.mdBlock);
      edited.push({
        index: index === null || Number.isNaN(index) ? null : index,
        innerHtml: node.innerHTML,
        outerHtml: serializableHtml(node),
      });
    }
    return serializeEditedMarkdown({ source: markdown, blocks: blocksRef.current, edited });
  }, [markdown]);

  useImperativeHandle(props.ref, () => ({ read }), [read]);

  return (
    <div
      ref={rootRef}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline
      aria-label={props.label}
      spellCheck
      onInput={props.onInput}
      onPaste={pastePlainText}
      data-testid="markdown-document-editor"
      className={cn("preview-markdown min-h-full outline-none", props.className)}
    >
      <FrozenDocument markdown={markdown} />
    </div>
  );
}
