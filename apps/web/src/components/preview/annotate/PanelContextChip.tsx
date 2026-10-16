/**
 * The chip in the composer for what the panel's browser sent (w0138): one
 * line — "💬 2 comments · /pricing ▾" and the first note, muted. The chevron
 * opens the list (each note with where it is on the page) right in the
 * composer; the selectors are only there.
 */
import {
  ChevronDownIcon,
  CircleAlertIcon,
  MessageSquareTextIcon,
  NetworkIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "../../../lib/utils";
import type { PanelContextCard } from "./pageTools.logic";

const ICON = {
  comments: MessageSquareTextIcon,
  error: CircleAlertIcon,
  request: NetworkIcon,
  errors: TriangleAlertIcon,
} as const;

export function PanelContextChip({
  card,
  onRemove,
}: {
  card: PanelContextCard;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = ICON[card.kind];
  return (
    <div
      className={cn(
        "relative min-w-0 self-start rounded-lg border border-border/80 bg-background text-left",
        open ? "w-80 max-w-full" : "max-w-80",
      )}
      data-testid="composer-panel-context"
      title={`${card.title} — from ${card.page}`}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg pr-7 pl-2 hover:bg-accent/40"
      >
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            card.kind === "comments" ? "text-primary" : "text-destructive",
          )}
        />
        <span className="shrink-0 text-xs font-medium text-foreground/90">{card.chip}</span>
        {card.preview && !open ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{card.preview}</span>
        ) : null}
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <ol className="max-h-44 overflow-y-auto border-t border-border/70 px-2.5 py-1.5">
          {card.items.map((item, index) => (
            <li
              // Two identical errors are two lines.
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              className="flex gap-2 py-1 text-[11px] leading-snug"
            >
              <span
                className={cn(
                  "mt-px inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold",
                  card.kind === "comments"
                    ? "bg-primary text-primary-foreground"
                    : item.tone === "warn"
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-destructive",
                )}
              >
                {item.marker}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-foreground/90">{item.label}</span>
                {item.detail ? (
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {item.detail}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${card.title}`}
        className="absolute top-1.5 right-1.5 inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
