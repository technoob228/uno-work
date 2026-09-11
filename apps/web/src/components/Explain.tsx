/**
 * Inline "what is this?" helpers backed by the plain-language vocabulary.
 *
 * `<Explain term="…" />` is a small "?" that shows the term's one-line
 * explanation on hover / focus. `<PlainTerm term="…" />` renders the label
 * itself with a dotted underline and the same tooltip, for prose where a
 * separate icon would be noisy. Both read from `plainLanguage.ts`, so a
 * concept is explained the same way everywhere it appears.
 */
import { CircleHelpIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  PLAIN_TERMS,
  plainLabel,
  plainLabelWithTechnical,
  type PlainTerm as PlainTermKey,
} from "../plainLanguage";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function ExplainTooltipBody({
  term,
  technical,
}: {
  term: PlainTermKey;
  technical?: boolean | undefined;
}) {
  const entry = PLAIN_TERMS[term];
  return (
    <span className="block max-w-64 text-left">
      <span className="block font-medium text-foreground">
        {technical ? plainLabelWithTechnical(term) : entry.label}
      </span>
      <span className="block text-muted-foreground">{entry.explanation}</span>
    </span>
  );
}

export interface ExplainProps {
  readonly term: PlainTermKey;
  /** Show the technical name in the tooltip title — first mention on a screen only. */
  readonly technical?: boolean | undefined;
  readonly className?: string | undefined;
}

/**
 * A subtle "?" glyph. Sits next to a heading, label or control and explains
 * the concept in one sentence. Keyboard-focusable so the explanation is
 * reachable without a mouse.
 */
export function Explain({ term, technical, className }: ExplainProps) {
  const label = plainLabel(term);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`What is “${label}”?`}
            data-slot="explain"
            className={cn(
              "inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full align-middle text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              className,
            )}
          />
        }
      >
        <CircleHelpIcon className="size-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <ExplainTooltipBody term={term} technical={technical} />
      </TooltipPopup>
    </Tooltip>
  );
}

export interface PlainTermProps {
  readonly term: PlainTermKey;
  /** Override the visible text (e.g. plural or lowercase) while keeping the tooltip. */
  readonly children?: ReactNode;
  readonly technical?: boolean | undefined;
  readonly className?: string | undefined;
}

/** The term's label with a dotted underline and the explanation on hover. */
export function PlainTerm({ term, children, technical, className }: PlainTermProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            data-slot="plain-term"
            className={cn(
              "cursor-help underline decoration-muted-foreground/50 decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
              className,
            )}
          />
        }
      >
        {children ?? (technical ? plainLabelWithTechnical(term) : plainLabel(term))}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <ExplainTooltipBody term={term} technical={technical} />
      </TooltipPopup>
    </Tooltip>
  );
}
