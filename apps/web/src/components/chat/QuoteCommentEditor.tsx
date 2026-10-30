/**
 * The remark on a quote (T3 `AssistantCitationCommentEditor`): Enter saves,
 * ⌘Enter saves and sends, Shift+Enter is a new line, Esc cancels.
 */
import { useEffect, useRef, useState } from "react";

import { QUOTE_MAX_COMMENT_LENGTH } from "../../lib/chatQuotes";
import { Button } from "../ui/button";

export function QuoteCommentEditor({
  initial = "",
  onSave,
  onSaveAndSend,
  onCancel,
}: {
  initial?: string;
  onSave: (comment: string) => void;
  onSaveAndSend?: (comment: string) => void;
  onCancel: () => void;
}) {
  const [comment, setComment] = useState(initial);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, []);
  const tooLong = comment.length > QUOTE_MAX_COMMENT_LENGTH;
  const save = (send: boolean) => {
    if (tooLong) return;
    const words = comment.trim();
    if (send && onSaveAndSend) onSaveAndSend(words);
    else onSave(words);
  };
  return (
    <div
      data-testid="quote-comment-editor"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <textarea
        ref={inputRef}
        aria-label="Comment on selected text"
        aria-invalid={tooLong || undefined}
        placeholder="Add an optional comment..."
        rows={2}
        className="field-sizing-content block max-h-40 min-h-14 w-full resize-none bg-transparent px-1 py-1.5 text-base outline-none placeholder:text-muted-foreground sm:text-sm"
        value={comment}
        onChange={(event) => setComment(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            save(event.metaKey || event.ctrlKey);
          }
        }}
      />
      {tooLong ? (
        <p role="status" className="pt-1 text-xs text-destructive">
          Comments can be up to {QUOTE_MAX_COMMENT_LENGTH.toLocaleString()} characters.
        </p>
      ) : null}
      <div className="mt-1.5 flex items-center justify-end gap-1.5">
        <Button
          variant="outline"
          size="xs"
          onPointerDown={(event) => event.preventDefault()}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          size="xs"
          disabled={tooLong}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => save(false)}
        >
          Save
        </Button>
      </div>
    </div>
  );
}
