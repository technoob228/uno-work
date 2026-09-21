/**
 * A machine error as a person reads it: a title, one sentence, and the raw
 * text only behind "Show details". Every connect / create / wake surface uses
 * this instead of printing `error.message`.
 */
import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { describeMachineError, type HumanMachineError } from "../../machineErrors";

export function MachineErrorNotice({
  error,
  human,
  tone = "error",
  action,
  className,
}: {
  readonly error?: unknown;
  /** Pre-described error; wins over `error`. */
  readonly human?: HumanMachineError;
  readonly tone?: "error" | "warning";
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const described = human ?? describeMachineError(error);
  return (
    <div
      role="alert"
      data-testid="machine-error-notice"
      className={cn(
        "rounded-lg px-3 py-2 text-xs",
        tone === "error"
          ? "bg-destructive/8 text-destructive"
          : "bg-amber-500/10 text-amber-800 dark:text-amber-300",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium">{described.title}</p>
          <p className="text-foreground/80">{described.message}</p>
          {action ? <div className="flex flex-wrap items-center gap-2 pt-1">{action}</div> : null}
          {described.details ? (
            <div>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                aria-expanded={showDetails}
                onClick={() => setShowDetails((open) => !open)}
              >
                <ChevronDownIcon
                  className={cn("size-3 transition-transform", showDetails && "rotate-180")}
                  aria-hidden="true"
                />
                {showDetails ? "Hide details" : "Show details"}
              </button>
              {showDetails ? (
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-background/60 p-2 font-mono text-[10px] text-muted-foreground">
                  {described.details}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
