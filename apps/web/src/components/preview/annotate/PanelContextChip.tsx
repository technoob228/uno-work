/**
 * The card in the composer for what the panel's browser sent (w0138): "3
 * comments on /pricing", "Error on /pricing", "POST /api/order · 500". One
 * card per send; the chevron opens its list (pins with notes, the error, the
 * request) right in the composer.
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
  const subtitle =
    card.kind === "comments"
      ? card.items
          .map((item) => item.detail ?? item.label)
          .slice(0, 3)
          .join(", ")
      : (card.items[0]?.label ?? "");
  return (
    <div
      className={cn(
        "relative min-w-0 rounded-lg border border-border/80 bg-background text-left transition-[width]",
        open ? "w-80" : "w-56",
      )}
      data-testid="composer-panel-context"
      title={`${card.title} — from ${card.page}`}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-16 w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg py-2 pr-7 pl-2.5 hover:bg-accent/40"
      >
        <span
          className={cn(
            "inline-flex size-7 shrink-0 items-center justify-center rounded-md",
            card.kind === "comments"
              ? "bg-primary/10 text-primary"
              : "bg-destructive/10 text-destructive",
          )}
        >
          <Icon className="size-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-foreground/90">
            {card.title}
          </span>
          <span className="block truncate font-mono text-[10px] text-muted-foreground">
            {subtitle}
          </span>
        </span>
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <ol className="max-h-44 overflow-y-auto border-t border-border/70 px-2.5 py-1.5">
          {card.items.map((item) => (
            <li
              key={`${item.marker}:${item.label}`}
              className="flex gap-2 py-1 text-[11px] leading-snug"
            >
              <span
                className={cn(
                  "mt-px inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold",
                  card.kind === "comments"
                    ? "bg-primary text-primary-foreground"
                    : item.tone === "warn"
                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                      : "bg-destructive/12 text-destructive",
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
        className="absolute top-1 right-1 inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
