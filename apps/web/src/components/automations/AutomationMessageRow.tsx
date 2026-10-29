/**
 * The message an automation put into a chat, folded (29.10, upstream
 * d27c6067a9): one row "⏰ Automation · <name>" on the person's side, which
 * opens to what it was asked (the trigger and the instruction). The prompt is
 * a long, repeated runbook — the answer below it is what matters.
 */
import type { UnoWorkNote } from "@t3tools/shared/secretRequestCopy";
import { AlarmClockIcon, ChevronDownIcon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "../../lib/utils";

type AutomationNote = Extract<UnoWorkNote, { kind: "automation" }>;

export const AutomationMessageRow = memo(function AutomationMessageRow(props: {
  readonly note: AutomationNote;
}) {
  const [expanded, setExpanded] = useState(false);
  const { note } = props;
  return (
    <div className="flex flex-col items-end gap-1" data-testid="automation-message">
      <div
        className={cn(
          "min-w-0 max-w-[80%] rounded-2xl border border-border/70 bg-muted/40",
          expanded && "w-full",
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-2xl px-3 py-1.5 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring"
          data-testid="automation-message-toggle"
        >
          <AlarmClockIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-muted-foreground">Automation</span>
          <span className="shrink-0 text-muted-foreground/60">·</span>
          <span className="min-w-0 flex-1 truncate font-medium">{note.name}</span>
          {note.trigger ? (
            <span className="hidden shrink-0 truncate text-xs text-muted-foreground sm:inline">
              {note.trigger}
            </span>
          ) : null}
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
        {expanded ? (
          <div
            className="max-h-96 overflow-auto px-3 pb-3 text-sm leading-relaxed whitespace-pre-wrap wrap-break-word text-foreground/90"
            data-testid="automation-message-body"
          >
            {note.trigger ? (
              <p className="mb-1.5 text-xs text-muted-foreground">Ran: {note.trigger}</p>
            ) : null}
            {note.body}
          </div>
        ) : null}
      </div>
    </div>
  );
});
