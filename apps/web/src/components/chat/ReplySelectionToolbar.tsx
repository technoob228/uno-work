/**
 * Select text in an agent's reply: a small Quote button at the selection (T3
 * `AssistantSelectionToolbar`), then the comment box in its place. The saved
 * quote waits by the composer and goes with the next message.
 */
import { QuoteIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { QUOTE_MAX_TEXT_LENGTH } from "../../lib/chatQuotes";
import {
  isSelectionRectVisible,
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "../../lib/selectionActions";
import { Button } from "../ui/button";
import { QuoteCommentEditor } from "./QuoteCommentEditor";

export const REPLY_QUOTE_SOURCE_ATTRIBUTE = "data-reply-quote-source";
const SOURCE_SELECTOR = `[${REPLY_QUOTE_SOURCE_ATTRIBUTE}]`;
const EDITOR_WIDTH = 320;
const EDITOR_HEIGHT = 190;

const closestSource = (node: Node | null) =>
  (node instanceof Element ? node : (node?.parentElement ?? null))?.closest<HTMLElement>(
    SOURCE_SELECTOR,
  ) ?? null;

/**
 * The selected text of one reply. A paragraph picked by triple click ends at
 * the start of whatever follows, so the range is cut to the reply it began in.
 */
export function selectedReplyText(
  viewport: HTMLElement,
  selection: Selection | null,
): { readonly text: string; readonly range: Range } | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const selected = selection.getRangeAt(0);
  const source = closestSource(selected.startContainer) ?? closestSource(selected.endContainer);
  if (!source || !viewport.contains(source)) return null;
  const range = selected.cloneRange();
  if (!source.contains(range.startContainer)) range.setStart(source, 0);
  if (!source.contains(range.endContainer)) range.setEnd(source, source.childNodes.length);
  const text = range.toString().trim();
  return text ? { text, range } : null;
}

export function ReplySelectionToolbar({
  viewport,
  onQuote,
  onQuoteAndSend,
}: {
  viewport: HTMLElement | null;
  onQuote: (quote: { text: string; comment: string }) => void;
  onQuoteAndSend: (quote: { text: string; comment: string }) => void;
}) {
  const [selection, setSelection] = useState<{
    text: string;
    position: SelectionActionPoint;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const actionRef = useRef<HTMLDivElement | null>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the floating box and keeps it inside the window before paint
  useLayoutEffect(() => {
    const action = actionRef.current;
    if (!action || !selection) return;
    const rect = action.getBoundingClientRect();
    action.style.left = `${Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8))}px`;
    action.style.top = `${Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [selection, editing]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the document's selection to follow what is selected in replies
  useEffect(() => {
    if (!viewport) return;
    const clear = () => {
      setSelection(null);
      setEditing(false);
    };
    const update = (pointer: SelectionActionPoint | null) => {
      if (editingRef.current) return;
      const captured = selectedReplyText(viewport, window.getSelection());
      if (!captured) {
        clear();
        return;
      }
      const bounds = viewport.getBoundingClientRect();
      const lines = captured.range.getClientRects();
      const last = lines.item(lines.length - 1) ?? captured.range.getBoundingClientRect();
      if (!isSelectionRectVisible(captured.range.getBoundingClientRect(), [bounds])) {
        clear();
        return;
      }
      setSelection({
        text: captured.text,
        position: resolveSelectionActionPosition({
          bounds,
          selectionRect: last,
          pointer,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      });
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => actionRef.current,
      restoreAfterScroll: true,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [viewport]);

  if (!selection) return null;
  const tooLong = selection.text.length > QUOTE_MAX_TEXT_LENGTH;
  const done = () => {
    actionsRef.current?.cancel();
    setSelection(null);
    setEditing(false);
    window.getSelection()?.removeAllRanges();
  };
  const cancel = () => {
    actionsRef.current?.cancel();
    setSelection(null);
    setEditing(false);
  };
  return createPortal(
    editing ? (
      <div
        ref={actionRef}
        className="fixed z-50 rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-xl"
        style={{
          width: EDITOR_WIDTH,
          maxWidth: "calc(100vw - 1rem)",
          left: selection.position.x,
          top: Math.min(selection.position.y, window.innerHeight - EDITOR_HEIGHT),
        }}
      >
        <blockquote className="line-clamp-2 border-l-2 border-border pl-2 text-xs text-muted-foreground">
          {selection.text}
        </blockquote>
        <QuoteCommentEditor
          onSave={(comment) => {
            onQuote({ text: selection.text, comment });
            done();
          }}
          onSaveAndSend={(comment) => {
            onQuoteAndSend({ text: selection.text, comment });
            done();
          }}
          onCancel={cancel}
        />
      </div>
    ) : (
      <div
        ref={actionRef}
        className="fixed z-50"
        style={{ left: selection.position.x, top: selection.position.y }}
      >
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={tooLong}
          className="shadow-md"
          data-testid="reply-quote-button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => setEditing(true)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") cancel();
          }}
        >
          <QuoteIcon aria-hidden="true" className="size-3.5" />
          {tooLong ? "Shorten selection" : "Quote"}
        </Button>
      </div>
    ),
    document.body,
  );
}
