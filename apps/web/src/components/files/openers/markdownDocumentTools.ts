/**
 * The formatting tools of the markdown document editor (Misha 11.10: "minimal
 * tools like Notion's — bullets, formatting, sizes — few, but good and
 * handy"), the DOM side. Three ways to the same commands, as editors people
 * know do it:
 *
 * - the toolbar above the document (always there, so nothing has to be known
 *   in advance; a press never drops the selection);
 * - markdown as you type: `# `, `## `, `### `, `- `, `1. `, `> `, `[] ` at the
 *   start of a line turn it into that block;
 * - the usual shortcuts (⌘B, ⌘I, ⌘K, ⌘E, ⌘⇧X, ⌘⌥1–3, ⌘⇧7/8/9; Tab in a list).
 *
 * Everything goes through the browser's own editing commands where one
 * exists, so undo (⌘Z) takes a step back as expected.
 */

/** What a line is. */
export type DocumentBlockKind =
  | "text"
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "numbered"
  | "todo"
  | "quote"
  | "code";

export type DocumentInlineKind = "bold" | "italic" | "strike" | "code";

/** What the tools show as on, for where the caret is. */
export interface DocumentToolState {
  readonly block: DocumentBlockKind;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strike: boolean;
  readonly code: boolean;
  /** The address of the link under the caret, or null. */
  readonly link: string | null;
}

/** The block a typed prefix stands for, or null: `#`, `##`, `###`, `-`, `*`, `+`, `1.`, `>`, `[]`. */
export function blockOfTypedPrefix(prefix: string): DocumentBlockKind | null {
  switch (prefix) {
    case "#":
      return "h1";
    case "##":
      return "h2";
    case "###":
      return "h3";
    case "-":
    case "*":
    case "+":
      return "bullet";
    case "1.":
    case "1)":
      return "numbered";
    case ">":
      return "quote";
    case "[]":
    case "[ ]":
      return "todo";
    default:
      return null;
  }
}

/** A link as people type it: `example.com` gets its `https://`. */
export function normalizeLinkAddress(raw: string): string {
  const value = raw.trim();
  if (value.length === 0) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || /^[#/.]/.test(value)) return value;
  return /^[^\s/]+\.[^\s/]+/.test(value) ? `https://${value}` : value;
}

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** The selection, when it lies inside the document. */
function selectionIn(root: HTMLElement): Selection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  return root.contains(selection.anchorNode) ? selection : null;
}

function closestIn(root: HTMLElement, node: Node | null, selector: string): HTMLElement | null {
  const found = elementOf(node)?.closest<HTMLElement>(selector) ?? null;
  return found && found !== root && root.contains(found) ? found : null;
}

function isTaskItem(item: Element): boolean {
  return item.querySelector(':scope > input[type="checkbox"]') !== null;
}

function blockKindAt(root: HTMLElement, node: Node | null): DocumentBlockKind {
  const item = closestIn(root, node, "li");
  if (item) {
    if (item.parentElement?.tagName === "OL") return "numbered";
    return isTaskItem(item) ? "todo" : "bullet";
  }
  if (closestIn(root, node, "pre")) return "code";
  const heading = closestIn(root, node, "h1,h2,h3");
  if (heading) return heading.tagName.toLowerCase() as "h1" | "h2" | "h3";
  return closestIn(root, node, "blockquote") ? "quote" : "text";
}

export function readDocumentToolState(root: HTMLElement): DocumentToolState | null {
  const selection = selectionIn(root);
  if (!selection) return null;
  const node = selection.anchorNode;
  const code = closestIn(root, node, "code");
  return {
    block: blockKindAt(root, node),
    bold: document.queryCommandState("bold"),
    italic: document.queryCommandState("italic"),
    strike: document.queryCommandState("strikeThrough"),
    code: code !== null && code.closest("pre") === null,
    link: closestIn(root, node, "a")?.getAttribute("href") ?? null,
  };
}

function selectContents(node: Node): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toggleInlineCode(root: HTMLElement, selection: Selection): void {
  const existing = closestIn(root, selection.anchorNode, "code");
  if (existing && existing.closest("pre") === null) {
    const text = document.createTextNode(existing.textContent ?? "");
    existing.replaceWith(text);
    selectContents(text);
    return;
  }
  const text = selection.toString();
  // Code is one run of text on one line: nothing to wrap, or a selection across blocks.
  if (text.length === 0 || text.includes("\n")) return;
  document.execCommand("insertHTML", false, `<code>${escapeHtml(text)}</code>`);
}

export function applyDocumentInline(root: HTMLElement, kind: DocumentInlineKind): void {
  const selection = selectionIn(root);
  if (!selection) return;
  switch (kind) {
    case "bold":
      document.execCommand("bold");
      return;
    case "italic":
      document.execCommand("italic");
      return;
    case "strike":
      document.execCommand("strikeThrough");
      return;
    case "code":
      toggleInlineCode(root, selection);
      return;
  }
}

function newCheckbox(): HTMLInputElement {
  const box = document.createElement("input");
  box.type = "checkbox";
  return box;
}

/** Every item of a to-do list has its box (Enter makes a new item without one). */
export function ensureTaskCheckboxes(root: HTMLElement): void {
  for (const item of root.querySelectorAll<HTMLLIElement>("ul.contains-task-list > li")) {
    item.classList.add("task-list-item");
    if (isTaskItem(item)) continue;
    const selection = window.getSelection();
    const caretAtStart =
      selection !== null &&
      selection.isCollapsed &&
      item.contains(selection.anchorNode) &&
      caretOffsetIn(item, selection) === 0;
    const space = document.createTextNode(" ");
    item.prepend(newCheckbox(), space);
    // The caret stood at the item's start: typing goes after the box, not before it.
    if (caretAtStart) selection.collapse(space, 1);
  }
}

/** How much text of `block` stands before the caret. */
function caretOffsetIn(block: HTMLElement, selection: Selection): number {
  if (!selection.anchorNode) return 0;
  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(selection.anchorNode, selection.anchorOffset);
  return before.toString().length;
}

/**
 * The browser may put a new list inside the paragraph it came from (`<p><ul>`),
 * and every line typed after it lands in that paragraph too. A list is a block
 * of the document on its own: lift it out.
 */
function liftListsOutOfParagraphs(root: HTMLElement): void {
  for (const list of root.querySelectorAll<HTMLElement>(":scope > p > ul, :scope > p > ol")) {
    const paragraph = list.parentElement;
    if (!paragraph) continue;
    const before: Node[] = [];
    const after: Node[] = [];
    let passed = false;
    for (const child of Array.from(paragraph.childNodes)) {
      if (child === list) passed = true;
      else (passed ? after : before).push(child);
    }
    const holds = (nodes: Node[]) =>
      nodes.some((node) => node.nodeName !== "BR" && (node.textContent ?? "").trim().length > 0);
    const pieces: Node[] = [];
    if (holds(before)) {
      const head = document.createElement("p");
      head.append(...before);
      pieces.push(head);
    }
    pieces.push(list);
    // What followed the list inside the paragraph are blocks or text of their own.
    for (const node of after) {
      if (node.nodeType === Node.ELEMENT_NODE && node.nodeName !== "BR") pieces.push(node);
      else if ((node.textContent ?? "").trim().length > 0) {
        const tail = document.createElement("p");
        tail.append(node);
        pieces.push(tail);
      }
    }
    // Moving the list takes the caret out of it: put it back where it stood.
    const selection = window.getSelection();
    const caret =
      selection && selection.anchorNode && selection.focusNode
        ? ([
            selection.anchorNode,
            selection.anchorOffset,
            selection.focusNode,
            selection.focusOffset,
          ] as const)
        : null;
    paragraph.replaceWith(...pieces);
    if (selection && caret && root.contains(caret[0]) && root.contains(caret[2])) {
      selection.setBaseAndExtent(...caret);
    }
  }
}

/** Run an editing command and keep the caret where it was, in the same text. */
function keepingCaret(root: HTMLElement, command: () => void): void {
  const selection = window.getSelection();
  const saved =
    selection && selection.rangeCount > 0
      ? {
          anchorNode: selection.anchorNode,
          anchorOffset: selection.anchorOffset,
          focusNode: selection.focusNode,
          focusOffset: selection.focusOffset,
        }
      : null;
  // Remember the caret two ways: by its text node (exact, when the node survives
  // the change) and by how far it stands from the end of its line (the browser
  // makes a list out of new nodes, and a box may come in front of the text).
  const anchor = saved?.anchorNode ? textPoint(saved.anchorNode, saved.anchorOffset) : null;
  const focus = saved?.focusNode ? textPoint(saved.focusNode, saved.focusOffset) : null;
  const line = saved?.anchorNode ? lineOf(root, saved.anchorNode) : null;
  const fromEnd =
    selection && line && saved?.focusNode && lineOf(root, saved.focusNode) === line
      ? {
          anchor: textAfter(line, saved.anchorNode!, saved.anchorOffset),
          focus: textAfter(line, saved.focusNode, saved.focusOffset),
        }
      : null;
  command();
  liftListsOutOfParagraphs(root);
  if (!selection) return;
  try {
    if (anchor && focus && root.contains(anchor.node) && root.contains(focus.node)) {
      selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
      return;
    }
    const now = selection.anchorNode ? lineOf(root, selection.anchorNode) : null;
    if (!fromEnd || !now) return;
    const start = pointFromEnd(now, fromEnd.anchor);
    const end = pointFromEnd(now, fromEnd.focus);
    if (start && end) selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
  } catch {
    // The text changed under the caret: the browser's own placement stands.
  }
}

/** The line a point is in: its list item, or its block of the document. */
function lineOf(root: HTMLElement, node: Node): HTMLElement | null {
  return closestIn(root, node, "li") ?? rootBlockOf(root, node);
}

/** How much text of `line` stands after the point. */
function textAfter(line: HTMLElement, node: Node, offset: number): number {
  const after = document.createRange();
  after.selectNodeContents(line);
  after.setStart(node, offset);
  return after.toString().length;
}

/** The point of `line` with `count` characters of text after it. */
function pointFromEnd(line: HTMLElement, count: number): { node: Text; offset: number } | null {
  const texts: Text[] = [];
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  let left = count;
  for (const text of texts.toReversed()) {
    if (left <= text.length) return { node: text, offset: text.length - left };
    left -= text.length;
  }
  const first = texts[0];
  return first ? { node: first, offset: 0 } : null;
}

/** The same point of the document, counted in a text node (a caret may be given by its element). */
function textPoint(node: Node, offset: number): { node: Text; offset: number } | null {
  if (node.nodeType === Node.TEXT_NODE) return { node: node as Text, offset };
  const before = offset > 0 ? node.childNodes[offset - 1] : undefined;
  if (before) {
    const walker = document.createTreeWalker(before, NodeFilter.SHOW_TEXT);
    let last: Text | null = before.nodeType === Node.TEXT_NODE ? (before as Text) : null;
    while (walker.nextNode()) last = walker.currentNode as Text;
    if (last) return { node: last, offset: last.length };
  }
  const after = node.childNodes[offset];
  if (!after) return null;
  if (after.nodeType === Node.TEXT_NODE) return { node: after as Text, offset: 0 };
  const first = document.createTreeWalker(after, NodeFilter.SHOW_TEXT).nextNode();
  return first ? { node: first as Text, offset: 0 } : null;
}

function plainListOf(list: HTMLElement): void {
  list.classList.remove("contains-task-list");
  for (const item of list.querySelectorAll<HTMLLIElement>(":scope > li")) {
    item.classList.remove("task-list-item");
    const box = item.querySelector(':scope > input[type="checkbox"]');
    if (box?.nextSibling?.nodeType === Node.TEXT_NODE) {
      const text = box.nextSibling;
      text.textContent = (text.textContent ?? "").replace(/^\s/, "");
    }
    box?.remove();
  }
}

/** Make the line(s) under the selection `kind`; pressing the kind it already is gives plain text back. */
export function applyDocumentBlock(root: HTMLElement, kind: DocumentBlockKind): void {
  if (!selectionIn(root)) return;
  keepingCaret(root, () => changeBlock(root, kind));
}

function changeBlock(root: HTMLElement, kind: DocumentBlockKind): void {
  const selection = selectionIn(root);
  if (!selection) return;
  const current = blockKindAt(root, selection.anchorNode);
  // A code block keeps its text as it is: no turning it into something else from here.
  if (current === "code") return;
  const target: DocumentBlockKind = kind === current ? "text" : kind;

  // Out of what it is now…
  const list = closestIn(root, selection.anchorNode, "li")?.parentElement ?? null;
  if (list && (current === "bullet" || current === "numbered" || current === "todo")) {
    if (current === "todo") plainListOf(list);
    if (target === "bullet" && current === "todo") return;
    if (target === "todo" && current === "bullet") {
      list.classList.add("contains-task-list");
      ensureTaskCheckboxes(root);
      return;
    }
    document.execCommand(current === "numbered" ? "insertOrderedList" : "insertUnorderedList");
  } else if (current === "quote") {
    document.execCommand("outdent");
  }

  // …and into what was asked.
  switch (target) {
    case "text":
      document.execCommand("formatBlock", false, "p");
      return;
    case "h1":
    case "h2":
    case "h3":
    case "quote":
      document.execCommand("formatBlock", false, target === "quote" ? "blockquote" : target);
      return;
    case "numbered":
      document.execCommand("insertOrderedList");
      return;
    case "bullet":
    case "todo": {
      document.execCommand("insertUnorderedList");
      if (target !== "todo") return;
      const made = closestIn(root, window.getSelection()?.anchorNode ?? null, "li")?.parentElement;
      if (!made) return;
      made.classList.add("contains-task-list");
      ensureTaskCheckboxes(root);
      return;
    }
    case "code":
      return;
  }
}

/** Link the selection to `address`; an empty address takes the link off. */
export function applyDocumentLink(root: HTMLElement, address: string): void {
  const selection = selectionIn(root);
  if (!selection) return;
  const href = normalizeLinkAddress(address);
  const existing = closestIn(root, selection.anchorNode, "a");
  if (existing && selection.isCollapsed) selectContents(existing);
  if (href.length === 0) {
    document.execCommand("unlink");
    return;
  }
  if (window.getSelection()?.isCollapsed) {
    document.execCommand(
      "insertHTML",
      false,
      `<a href="${escapeHtml(href).replace(/"/g, "&quot;")}">${escapeHtml(href)}</a>`,
    );
    return;
  }
  document.execCommand("createLink", false, href);
}

/** The top-level block of the document the node is in. */
function rootBlockOf(root: HTMLElement, node: Node | null): HTMLElement | null {
  let current = elementOf(node);
  while (current && current.parentElement !== root) current = current.parentElement;
  return current instanceof HTMLElement ? current : null;
}

/**
 * After a space was typed: `# `, `- `, `1. `, `> `, `[] `… at the start of a
 * plain line turn the line into that block and the typed characters go.
 */
export function applyTypedBlockShortcut(root: HTMLElement): boolean {
  const selection = selectionIn(root);
  if (!selection || !selection.isCollapsed || !selection.anchorNode) return false;
  const block = rootBlockOf(root, selection.anchorNode);
  if (!block || (block.tagName !== "P" && block.tagName !== "DIV")) return false;
  const typed = document.createRange();
  typed.selectNodeContents(block);
  typed.setEnd(selection.anchorNode, selection.anchorOffset);
  const text = typed.toString().replace(/ /g, " ");
  if (!text.endsWith(" ") || text.length > 5) return false;
  const kind = blockOfTypedPrefix(text.slice(0, -1));
  if (!kind) return false;
  selection.removeAllRanges();
  selection.addRange(typed);
  document.execCommand("delete");
  applyDocumentBlock(root, kind);
  return true;
}

/** Text typed straight into an emptied document gets its paragraph. */
export function wrapLooseText(root: HTMLElement): void {
  const selection = selectionIn(root);
  if (!selection || selection.anchorNode?.parentNode !== root) return;
  if (selection.anchorNode.nodeType !== Node.TEXT_NODE) return;
  document.execCommand("formatBlock", false, "p");
}

/**
 * Tab / Shift+Tab in a list: the item goes a level deeper or back. The browser
 * hangs the deeper list next to the item above (`<ul><li/><ul/></ul>`); a list
 * inside a list belongs to that item, so it is moved into it.
 */
export function indentListItem(root: HTMLElement, direction: "indent" | "outdent"): void {
  document.execCommand(direction);
  const selection = window.getSelection();
  const caret =
    selection && selection.anchorNode && selection.focusNode
      ? ([
          selection.anchorNode,
          selection.anchorOffset,
          selection.focusNode,
          selection.focusOffset,
        ] as const)
      : null;
  for (const nested of root.querySelectorAll<HTMLElement>("ul > ul, ul > ol, ol > ul, ol > ol")) {
    const above = nested.previousElementSibling;
    if (above?.tagName === "LI") above.append(nested);
  }
  if (selection && caret && root.contains(caret[0]) && root.contains(caret[2])) {
    selection.setBaseAndExtent(...caret);
  }
}

/** Enter on an empty to-do item ends the list, as it does in any other list. */
export function leaveEmptyTaskItem(root: HTMLElement): boolean {
  const selection = selectionIn(root);
  const item = selection ? closestIn(root, selection.anchorNode, "li") : null;
  if (!selection || !item || !isTaskItem(item)) return false;
  if ((item.textContent ?? "").trim().length > 0) return false;
  item.classList.remove("task-list-item");
  item.replaceChildren(document.createElement("br"));
  selection.collapse(item, 0);
  // The browser's own way out of a list: the empty item becomes a line after it.
  document.execCommand("insertUnorderedList");
  liftListsOutOfParagraphs(root);
  return true;
}

/** Enter inside a code block is a new line of the same block, not a second block. */
export function insertCodeNewline(root: HTMLElement): boolean {
  const selection = selectionIn(root);
  const pre = selection ? closestIn(root, selection.anchorNode, "pre") : null;
  if (!selection || !pre) return false;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const tail = document.createRange();
  tail.selectNodeContents(pre);
  tail.setStart(range.endContainer, range.endOffset);
  // The last line shows only when something follows its line break.
  const atEnd = tail.toString().length === 0;
  const node = document.createTextNode(atEnd ? "\n\n" : "\n");
  range.insertNode(node);
  range.setStart(node, 1);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export type DocumentShortcut =
  | { readonly type: "inline"; readonly kind: DocumentInlineKind }
  | { readonly type: "block"; readonly kind: DocumentBlockKind }
  | { readonly type: "link" }
  | { readonly type: "indent" }
  | { readonly type: "outdent" };

/** The command a key press stands for; null leaves the key to the browser. */
export function documentShortcutOf(event: {
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}): DocumentShortcut | null {
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (!mod) {
    if (event.key === "Tab" && !event.altKey) {
      return { type: event.shiftKey ? "outdent" : "indent" };
    }
    return null;
  }
  // ⌘⌥1–3 / ⌘⌥0: sizes. `code` because ⌥ changes what the key types.
  if (event.altKey && !event.shiftKey) {
    switch (event.code) {
      case "Digit1":
        return { type: "block", kind: "h1" };
      case "Digit2":
        return { type: "block", kind: "h2" };
      case "Digit3":
        return { type: "block", kind: "h3" };
      case "Digit0":
        return { type: "block", kind: "text" };
      default:
        return null;
    }
  }
  if (event.altKey) return null;
  if (event.shiftKey) {
    switch (event.code) {
      case "Digit7":
        return { type: "block", kind: "numbered" };
      case "Digit8":
        return { type: "block", kind: "bullet" };
      case "Digit9":
        return { type: "block", kind: "todo" };
      case "KeyX":
        return { type: "inline", kind: "strike" };
      default:
        return null;
    }
  }
  if (key === "e") return { type: "inline", kind: "code" };
  if (key === "k") return { type: "link" };
  return null;
}
