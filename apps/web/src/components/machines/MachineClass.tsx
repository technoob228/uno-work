/**
 * Machine class in the interface (account/machineClass.ts): the choice when a
 * computer is made, and the small "Performance" badge where a computer is
 * shown with its details. Standard computers carry no badge.
 */
import type { UnoMachineClass } from "@t3tools/contracts";
import { GaugeIcon } from "lucide-react";

import {
  MACHINE_CLASS_OPTIONS,
  type MachineClassSettings,
  PERFORMANCE_LOCKED_TEXT,
  SEE_MAX_TEXT,
  MAX_PLAN_URL,
} from "../../account/machineClass";
import { cn } from "../../lib/utils";
import { openInNewTab } from "../../navigation/useOpenApp";

export function PerformanceBadge({
  machineClass,
  className,
}: {
  readonly machineClass: UnoMachineClass | null | undefined;
  readonly className?: string;
}) {
  if (machineClass !== "performance") return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[11px] font-medium text-foreground/80 [&_svg]:size-3",
        className,
      )}
      data-testid="performance-badge"
    >
      <GaugeIcon aria-hidden="true" />
      Performance
    </span>
  );
}

export function MachineClassPicker({
  settings,
  value,
  onChange,
  disabled = false,
  upgradeUrl = MAX_PLAN_URL,
}: {
  readonly settings: MachineClassSettings;
  readonly value: UnoMachineClass;
  readonly onChange: (next: UnoMachineClass) => void;
  readonly disabled?: boolean;
  readonly upgradeUrl?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">Class</span>
      <div
        className="grid grid-cols-2 gap-2"
        role="radiogroup"
        aria-label="Class"
        data-testid="machine-class-picker"
      >
        {MACHINE_CLASS_OPTIONS.map((option) => {
          const locked = option.id === "performance" && !settings.performanceIncluded;
          const selected = !locked && value === option.id;
          const title = (
            <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              {option.id === "performance" ? (
                <GaugeIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              ) : null}
              {option.title}
            </span>
          );
          if (locked) {
            return (
              <div
                key={option.id}
                role="radio"
                aria-checked={false}
                aria-disabled={true}
                className="flex flex-col gap-0.5 rounded-lg border border-border/60 px-3 py-2"
                data-testid={`machine-class-${option.id}`}
              >
                <span className="opacity-60">{title}</span>
                <span className="text-[11px] text-muted-foreground opacity-80">
                  {option.detail}
                </span>
                <span className="mt-1 text-[11px]">
                  <span className="font-medium text-foreground">{PERFORMANCE_LOCKED_TEXT}</span>
                  <span className="text-muted-foreground"> · </span>
                  <a
                    href={upgradeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-primary hover:underline"
                    data-testid="machine-class-see-max"
                    onClick={(event) => {
                      // The desktop app opens it in the browser, not in its window.
                      event.preventDefault();
                      openInNewTab(upgradeUrl);
                    }}
                  >
                    {SEE_MAX_TEXT}
                  </a>
                </span>
              </div>
            );
          }
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(option.id)}
              className={cn(
                "flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60",
                selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50",
              )}
              data-testid={`machine-class-${option.id}`}
            >
              {title}
              <span className="text-[11px] text-muted-foreground">{option.detail}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
