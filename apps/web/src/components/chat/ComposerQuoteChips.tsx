/**
 * Quotes waiting for the next message, in the composer's attachment row: one
 * line each; a click opens the passage and its comment for editing.
 */
import { QuoteIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { type ChatQuote, quoteSummary } from "../../lib/chatQuotes";
import { cn } from "../../lib/utils";
import { useComposerQuotesStore } from "../../composerQuotesStore";
import { QuoteCommentEditor } from "./QuoteCommentEditor";

export function ComposerQuoteChip({ threadKey, quote }: { threadKey: string; quote: ChatQuote }) {
  const [open, setOpen] = useState(false);
  const store = useComposerQuotesStore;
  return (
    <div
      className={cn(
        "relative min-w-0 self-start rounded-lg border border-border/80 bg-background text-left",
        open ? "w-80 max-w-full" : "max-w-64",
      )}
      data-testid="composer-quote"
      title={quote.page ?? undefined}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg pr-7 pl-2 hover:bg-accent/40"
      >
        <QuoteIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 truncate text-xs text-foreground/90">{quoteSummary(quote)}</span>
      </button>
      <button
        type="button"
        onClick={() => store.getState().remove(threadKey, quote.id)}
        aria-label="Remove quote"
        className="absolute top-1 right-1 inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </button>
      {open ? (
        <div className="border-t border-border/70 p-2">
          <blockquote className="line-clamp-4 border-l-2 border-border pl-2 text-xs text-muted-foreground">
            {quote.text}
          </blockquote>
          <QuoteCommentEditor
            initial={quote.comment}
            onSave={(comment) => {
              store.getState().setComment(threadKey, quote.id, comment);
              setOpen(false);
            }}
            onCancel={() => setOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Quotes in a sent message: the passage, then what the person said about it. */
export function SentQuotes({ quotes }: { quotes: ReadonlyArray<ChatQuote> }) {
  return (
    <div className="mb-2 flex flex-col gap-1.5" data-testid="sent-quotes">
      {quotes.map((quote) => (
        <div key={quote.id} className="min-w-0 text-sm">
          <blockquote
            className="line-clamp-3 border-l-2 border-foreground/20 pl-2 text-xs text-muted-foreground"
            title={quote.page ?? undefined}
          >
            {quote.text}
          </blockquote>
          {quote.comment ? (
            <p className="mt-0.5 whitespace-pre-wrap wrap-break-word">{quote.comment}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
