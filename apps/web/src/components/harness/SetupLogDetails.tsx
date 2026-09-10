/**
 * Collapsible tail of a setup job log. Errors show a one-line reason; the raw
 * output is one click away for anyone debugging an install.
 *
 * @module components/harness/SetupLogDetails
 */
import { ChevronDown } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

export function SetupLogDetails({ log, label = "Show output" }: { log: string; label?: string }) {
  const [open, setOpen] = useState(false);
  if (log.trim().length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 self-start text-[11px] font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
        {label}
      </button>
      {open ? (
        <pre className="max-h-48 overflow-auto rounded-md bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all">
          {log}
        </pre>
      ) : null}
    </div>
  );
}
