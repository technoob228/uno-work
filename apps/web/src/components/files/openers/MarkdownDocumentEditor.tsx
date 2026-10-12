/**
 * A markdown file edited as the document it reads as: the rendered markdown,
 * editable in place. What it writes back, and why block by block, is in
 * `markdownDocumentEdit.ts`.
 */
import {
  BoldIcon,
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  LinkIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  PilcrowIcon,
  StrikethroughIcon,
  TextQuoteIcon,
} from "lucide-react";
import {
  type ClipboardEvent,
  type ComponentType,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "../../../lib/utils";
import {
  type MarkdownEditedBlock,
  type MarkdownSourceBlock,
  serializeEditedMarkdown,
} from "./markdownDocumentEdit";
import {
  type DocumentBlockKind,
  type DocumentInlineKind,
  type DocumentToolState,
  applyDocumentBlock,
  applyDocumentInline,
  applyDocumentLink,
  applyTypedBlockShortcut,
  documentShortcutOf,
  ensureTaskCheckboxes,
  indentListItem,
  insertCodeNewline,
  leaveEmptyTaskItem,
  readDocumentToolState,
  wrapLooseText,
} from "./markdownDocumentTools";

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

/**
 * How a block reads: its tag and what is inside. The tag counts — a paragraph
 * made a heading keeps its text and its place, and is still a changed block.
 */
function blockSignature(element: HTMLElement): string {
  return `${element.tagName}\n${element.innerHTML}`;
}

/**
 * The renderer's checkboxes are React's (and disabled): a tick would be put
 * back. Fresh copies are plain DOM the person can tick.
 */
function freeCheckboxes(root: HTMLElement): void {
  for (const box of root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    const copy = box.cloneNode(false) as HTMLInputElement;
    copy.removeAttribute("disabled");
    box.replaceWith(copy);
  }
}

const MOD =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
const ALT = MOD === "⌘" ? "⌥" : "Alt+";
const SHIFT = MOD === "⌘" ? "⇧" : "Shift+";

type Tool =
  | { readonly type: "block"; readonly kind: DocumentBlockKind }
  | { readonly type: "inline"; readonly kind: DocumentInlineKind }
  | { readonly type: "link" };

interface ToolButton {
  readonly id: string;
  readonly tool: Tool;
  readonly label: string;
  /** How to get the same from the keyboard. */
  readonly hint: string;
  readonly Icon: ComponentType<{ className?: string }>;
}

/** Sizes, then how the text looks, then lists — each group between its dividers. */
const TOOL_GROUPS: ReadonlyArray<ReadonlyArray<ToolButton>> = [
  [
    {
      id: "text",
      tool: { type: "block", kind: "text" },
      label: "Text",
      hint: `${MOD}${ALT}0`,
      Icon: PilcrowIcon,
    },
    {
      id: "h1",
      tool: { type: "block", kind: "h1" },
      label: "Heading 1",
      hint: `${MOD}${ALT}1, or type #`,
      Icon: Heading1Icon,
    },
    {
      id: "h2",
      tool: { type: "block", kind: "h2" },
      label: "Heading 2",
      hint: `${MOD}${ALT}2, or type ##`,
      Icon: Heading2Icon,
    },
    {
      id: "h3",
      tool: { type: "block", kind: "h3" },
      label: "Heading 3",
      hint: `${MOD}${ALT}3, or type ###`,
      Icon: Heading3Icon,
    },
  ],
  [
    {
      id: "bold",
      tool: { type: "inline", kind: "bold" },
      label: "Bold",
      hint: `${MOD}B`,
      Icon: BoldIcon,
    },
    {
      id: "italic",
      tool: { type: "inline", kind: "italic" },
      label: "Italic",
      hint: `${MOD}I`,
      Icon: ItalicIcon,
    },
    {
      id: "strike",
      tool: { type: "inline", kind: "strike" },
      label: "Strikethrough",
      hint: `${MOD}${SHIFT}X`,
      Icon: StrikethroughIcon,
    },
    {
      id: "code",
      tool: { type: "inline", kind: "code" },
      label: "Code",
      hint: `${MOD}E`,
      Icon: CodeIcon,
    },
    { id: "link", tool: { type: "link" }, label: "Link", hint: `${MOD}K`, Icon: LinkIcon },
  ],
  [
    {
      id: "bullet",
      tool: { type: "block", kind: "bullet" },
      label: "Bulleted list",
      hint: `${MOD}${SHIFT}8, or type -`,
      Icon: ListIcon,
    },
    {
      id: "numbered",
      tool: { type: "block", kind: "numbered" },
      label: "Numbered list",
      hint: `${MOD}${SHIFT}7, or type 1.`,
      Icon: ListOrderedIcon,
    },
    {
      id: "todo",
      tool: { type: "block", kind: "todo" },
      label: "To-do list",
      hint: `${MOD}${SHIFT}9, or type []`,
      Icon: ListChecksIcon,
    },
    {
      id: "quote",
      tool: { type: "block", kind: "quote" },
      label: "Quote",
      hint: "type >",
      Icon: TextQuoteIcon,
    },
  ],
];

function toolIsOn(tool: Tool, state: DocumentToolState | null): boolean {
  if (!state) return false;
  if (tool.type === "block") return state.block === tool.kind;
  if (tool.type === "link") return state.link !== null;
  return state[tool.kind];
}

function sameToolState(left: DocumentToolState | null, right: DocumentToolState | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.block === right.block &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.strike === right.strike &&
    left.code === right.code &&
    left.link === right.link
  );
}

/** A press on a tool must not take the selection out of the document. */
function keepSelection(event: MouseEvent) {
  event.preventDefault();
}

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
    freeCheckboxes(root);
    // New lines are paragraphs, as markdown has them (the browser's own choice is a bare <div>).
    document.execCommand("defaultParagraphSeparator", false, "p");
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
      blocks.push({ start, end, html: blockSignature(child) });
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
        innerHtml: blockSignature(node),
        outerHtml: serializableHtml(node),
      });
    }
    return serializeEditedMarkdown({ source: markdown, blocks: blocksRef.current, edited });
  }, [markdown]);

  useImperativeHandle(props.ref, () => ({ read }), [read]);

  const { onInput } = props;
  const [tools, setTools] = useState<DocumentToolState | null>(null);
  // The link's address is typed in the toolbar: the selection it is for waits here.
  const [linkDraft, setLinkDraft] = useState<string | null>(null);
  const linkRange = useRef<Range | null>(null);

  const refreshTools = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const next = readDocumentToolState(root);
    // Out of the document (the link field, another pane): the tools keep what they showed.
    if (next) setTools((current) => (sameToolState(current, next) ? current : next));
  }, []);

  useEffect(() => {
    document.addEventListener("selectionchange", refreshTools);
    return () => document.removeEventListener("selectionchange", refreshTools);
  }, [refreshTools]);

  const changed = useCallback(() => {
    refreshTools();
    onInput();
  }, [onInput, refreshTools]);

  const openLink = useCallback(() => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return;
    if (!root.contains(selection.anchorNode)) return;
    linkRange.current = selection.getRangeAt(0).cloneRange();
    setLinkDraft(readDocumentToolState(root)?.link ?? "");
  }, []);

  const closeLink = useCallback(
    (address: string | null) => {
      const root = rootRef.current;
      const range = linkRange.current;
      linkRange.current = null;
      setLinkDraft(null);
      if (!root || !range) return;
      root.focus();
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (address === null) return;
      applyDocumentLink(root, address);
      changed();
    },
    [changed],
  );

  const run = useCallback(
    (tool: Tool) => {
      const root = rootRef.current;
      if (!root) return;
      if (tool.type === "link") {
        openLink();
        return;
      }
      if (tool.type === "block") applyDocumentBlock(root, tool.kind);
      else applyDocumentInline(root, tool.kind);
      changed();
    },
    [changed, openLink],
  );

  const onEditorInput = (event: FormEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (root) {
      const native = event.nativeEvent as InputEvent;
      wrapLooseText(root);
      if (native.inputType === "insertText" && native.data === " ") applyTypedBlockShortcut(root);
      ensureTaskCheckboxes(root);
    }
    changed();
  };

  const onEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      if (insertCodeNewline(root) || leaveEmptyTaskItem(root)) {
        event.preventDefault();
        changed();
      }
      return;
    }
    const shortcut = documentShortcutOf(event);
    if (!shortcut) return;
    if (shortcut.type === "indent" || shortcut.type === "outdent") {
      // Tab moves an item of a list deeper or back; anywhere else it stays the browser's.
      const block = readDocumentToolState(root)?.block;
      if (block !== "bullet" && block !== "numbered" && block !== "todo") return;
      event.preventDefault();
      indentListItem(root, shortcut.type);
      changed();
      return;
    }
    event.preventDefault();
    run(shortcut);
  };

  // A tick is a change of the file: written into the markup, so the block reads as touched.
  const onEditorClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
    if (target.checked) target.setAttribute("checked", "");
    else target.removeAttribute("checked");
    changed();
  };

  return (
    <>
      <div
        role="toolbar"
        aria-label="Formatting"
        data-testid="markdown-document-tools"
        className="sticky top-2 z-10 mb-4 flex flex-wrap items-center gap-0.5 rounded-lg border border-border bg-card/95 p-1 shadow-sm backdrop-blur"
      >
        {linkDraft === null ? (
          TOOL_GROUPS.map((group, index) => (
            <span key={group[0]!.id} className="flex items-center gap-0.5">
              {index > 0 ? <span className="mx-1 h-4 w-px bg-border" aria-hidden /> : null}
              {group.map(({ id, tool, label, hint, Icon }) => {
                const on = toolIsOn(tool, tools);
                return (
                  <button
                    key={id}
                    type="button"
                    title={`${label} · ${hint}`}
                    aria-label={label}
                    aria-pressed={on}
                    data-testid={`markdown-tool-${id}`}
                    onMouseDown={keepSelection}
                    onClick={() => run(tool)}
                    className={cn(
                      "grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                      on ? "bg-accent text-foreground" : "",
                    )}
                  >
                    <Icon className="size-4" />
                  </button>
                );
              })}
            </span>
          ))
        ) : (
          <form
            className="flex min-w-0 flex-1 items-center gap-1.5 px-1"
            onSubmit={(event) => {
              event.preventDefault();
              closeLink(linkDraft);
            }}
          >
            <LinkIcon className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={linkDraft}
              onChange={(event) => setLinkDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeLink(null);
                }
              }}
              placeholder="Paste or type a link, Enter to apply"
              aria-label="Link address"
              data-testid="markdown-link-address"
              className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <button
              type="submit"
              className="rounded-md px-2 py-1 text-xs font-medium hover:bg-accent"
              data-testid="markdown-link-apply"
            >
              {linkDraft.trim().length === 0 && tools?.link ? "Remove link" : "Apply"}
            </button>
            <button
              type="button"
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
              onClick={() => closeLink(null)}
            >
              Cancel
            </button>
          </form>
        )}
      </div>
      <div
        ref={rootRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline
        aria-label={props.label}
        spellCheck
        onInput={onEditorInput}
        onKeyDown={onEditorKeyDown}
        onClick={onEditorClick}
        onPaste={pastePlainText}
        data-testid="markdown-document-editor"
        className={cn("preview-markdown min-h-full outline-none", props.className)}
      >
        <FrozenDocument markdown={markdown} />
      </div>
    </>
  );
}
