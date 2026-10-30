/**
 * Paints find matches with the CSS Custom Highlight API: nothing in the
 * rendered message changes, so copy, selection and markdown stay as they are.
 * Adapted from upstream t3code `threadFindHighlights.ts`.
 */
import { findThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { useEffect, useRef } from "react";

const HIGHLIGHT_NAME = "uno-thread-find";
const ACTIVE_HIGHLIGHT_NAME = "uno-thread-find-active";
const TEXT_SELECTOR = "[data-thread-find-text]";
const ROW_SELECTOR = "[data-message-id]";

// Inline wrappers (code tokens) must not split a phrase; blocks must.
const BLOCK_TAGS = new Set(
  "address article aside blockquote br dd details div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tbody td th thead tr ul".split(
    " ",
  ),
);

interface FoundRange {
  readonly messageId: string;
  readonly occurrence: number;
  readonly range: Range;
}

export function collectThreadFindRanges(row: HTMLElement, query: string): FoundRange[] {
  if (query.length === 0) return [];
  const messageId = row.getAttribute("data-message-id");
  if (!messageId) return [];
  const ranges: FoundRange[] = [];
  let occurrence = 0;

  for (const scope of row.querySelectorAll(TEXT_SELECTOR)) {
    let text = "";
    let nodes: { node: Node; start: number; end: number }[] = [];
    const flush = () => {
      let startIndex = 0;
      let endIndex = 0;
      for (const offset of findThreadSearchOccurrences(text, query)) {
        while (startIndex < nodes.length && nodes[startIndex]!.end <= offset) startIndex += 1;
        if (endIndex < startIndex) endIndex = startIndex;
        while (endIndex < nodes.length && nodes[endIndex]!.end < offset + query.length) {
          endIndex += 1;
        }
        const start = nodes[startIndex];
        const end = nodes[endIndex];
        if (!start || !end) continue;
        const range = row.ownerDocument.createRange();
        range.setStart(start.node, offset - start.start);
        range.setEnd(end.node, offset + query.length - end.start);
        ranges.push({ messageId, occurrence, range });
        occurrence += 1;
      }
      text = "";
      nodes = [];
    };
    const visit = (node: Node, inPre = false) => {
      const element = node.nodeType === 1 ? (node as Element) : null;
      if (element?.matches("svg, button, [role='toolbar']")) return;
      const tag = element?.tagName.toLowerCase() ?? "";
      const block = BLOCK_TAGS.has(tag);
      if (block) flush();
      if (node.nodeType === 3) {
        const value = node.nodeValue ?? "";
        const start = text.length;
        text += inPre ? value : value.replace(/\r?\n/g, " ");
        nodes.push({ node, start, end: text.length });
      }
      for (const child of node.childNodes) visit(child, inPre || tag === "pre");
      if (block) flush();
    };
    visit(scope);
    flush();
  }
  return ranges;
}

export function useThreadFindHighlights(input: {
  readonly container: HTMLElement | null;
  readonly query: string;
  readonly activeMessageId: string | null;
  readonly activeOccurrence: number;
  readonly onActiveRange: (range: Range | null) => void;
}): void {
  const { container, query, activeMessageId, activeOccurrence, onActiveRange } = input;
  const rangesRef = useRef<readonly FoundRange[]>([]);
  const paintRef = useRef<((ranges: readonly FoundRange[]) => void) | null>(null);
  // Read from outside React too (the observer below): always this render's values.
  const latestRef = useRef({ activeMessageId, activeOccurrence, onActiveRange });
  latestRef.current = { activeMessageId, activeOccurrence, onActiveRange };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints CSS Highlight ranges for the query, repainting on DOM mutations, and clears them on cleanup
  useEffect(() => {
    if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
    const clear = () => {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      CSS.highlights.delete(ACTIVE_HIGHLIGHT_NAME);
    };
    rangesRef.current = [];
    if (!container || query.length === 0) {
      clear();
      latestRef.current.onActiveRange(null);
      return;
    }

    const inactive = new Highlight();
    const active = new Highlight();
    CSS.highlights.set(HIGHLIGHT_NAME, inactive);
    CSS.highlights.set(ACTIVE_HIGHLIGHT_NAME, active);
    const paint = (ranges: readonly FoundRange[]) => {
      const { activeMessageId: messageId, activeOccurrence: occurrence } = latestRef.current;
      const selected =
        ranges.find((found) => found.messageId === messageId && found.occurrence === occurrence)
          ?.range ?? null;
      inactive.clear();
      active.clear();
      for (const found of ranges) if (found.range !== selected) inactive.add(found.range);
      if (selected) active.add(selected);
      latestRef.current.onActiveRange(selected);
    };
    paintRef.current = paint;

    const cache = new Map<Element, readonly FoundRange[]>();
    const repaint = () => {
      const rows = new Set(container.querySelectorAll<HTMLElement>(ROW_SELECTOR));
      const ranges: FoundRange[] = [];
      for (const row of rows) {
        let matches = cache.get(row);
        if (
          !matches ||
          matches.some(
            ({ range }) => !row.contains(range.startContainer) || !row.contains(range.endContainer),
          )
        ) {
          matches = collectThreadFindRanges(row, query);
          cache.set(row, matches);
        }
        ranges.push(...matches);
      }
      for (const row of cache.keys()) if (!rows.has(row as HTMLElement)) cache.delete(row);
      rangesRef.current = ranges;
      paint(ranges);
    };

    let frame: number | null = null;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const target =
          mutation.target.nodeType === 1
            ? (mutation.target as Element)
            : mutation.target.parentElement;
        const row = target?.closest(ROW_SELECTOR);
        if (row) cache.delete(row);
      }
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        repaint();
      });
    });
    observer.observe(container, { subtree: true, childList: true, characterData: true });
    repaint();
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      cache.clear();
      paintRef.current = null;
      rangesRef.current = [];
      clear();
    };
  }, [container, query]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- repaints the active CSS Highlight range when the selected match changes
  useEffect(() => {
    paintRef.current?.(rangesRef.current);
  }, [activeMessageId, activeOccurrence]);
}
