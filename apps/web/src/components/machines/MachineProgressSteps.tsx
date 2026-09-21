/**
 * "Creating your computer… → Starting… → Connecting…" as three steps with the
 * current one spinning, so a person sees movement instead of one frozen label.
 */
import { CheckIcon, RefreshCwIcon } from "lucide-react";

import { cn } from "../../lib/utils";

export function MachineProgressSteps<Stage extends string>({
  steps,
  current,
  note,
}: {
  readonly steps: ReadonlyArray<{ readonly stage: Stage; readonly label: string }>;
  readonly current: Stage;
  /** One extra line under the steps, e.g. "Still starting — trying again…". */
  readonly note?: string | null;
}) {
  const currentIndex = Math.max(
    0,
    steps.findIndex((step) => step.stage === current),
  );
  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg bg-muted/50 px-3 py-2 text-xs"
      data-testid="machine-progress"
      aria-live="polite"
    >
      {steps.map((step, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        return (
          <div
            key={step.stage}
            data-state={done ? "done" : active ? "active" : "todo"}
            className={cn(
              "flex items-center gap-2",
              done
                ? "text-muted-foreground"
                : active
                  ? "text-foreground"
                  : "text-muted-foreground/50",
            )}
          >
            {done ? (
              <CheckIcon className="size-3 shrink-0 text-emerald-600" aria-hidden="true" />
            ) : active ? (
              <RefreshCwIcon className="size-3 shrink-0 animate-spin" aria-hidden="true" />
            ) : (
              <span
                className="size-3 shrink-0 rounded-full border border-current"
                aria-hidden="true"
              />
            )}
            <span className={cn(active && "font-medium")}>{step.label}</span>
          </div>
        );
      })}
      {note ? <p className="pl-5 text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}
