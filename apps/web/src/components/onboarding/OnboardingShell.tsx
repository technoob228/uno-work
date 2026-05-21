import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { UnoIcon } from "../Icons";
import { ONBOARDING_STEP_IDS, type OnboardingStepId } from "./useOnboardingState";

export interface OnboardingShellProps {
  stepId: OnboardingStepId;
  stepIndex: number;
  totalSteps: number;
  progressPercent: number;
  isFirst: boolean;
  isLast: boolean;
  canContinue?: boolean;
  continueLabel?: string;
  showSkip?: boolean;
  onBack: () => void;
  onContinue: () => void;
  onSkip: () => void;
  children: ReactNode;
}

export function OnboardingShell({
  stepId,
  stepIndex,
  totalSteps,
  progressPercent,
  isFirst,
  isLast,
  canContinue = true,
  continueLabel,
  showSkip = true,
  onBack,
  onContinue,
  onSkip,
  children,
}: OnboardingShellProps) {
  const visibleStepIds = ONBOARDING_STEP_IDS.slice(0, totalSteps);
  const computedContinueLabel = continueLabel ?? (isLast ? "Choose project folder" : "Continue");

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      <header className="drag-region flex h-14 shrink-0 items-center gap-3 border-b border-border pl-[90px] pr-5 wco:pl-[calc(env(titlebar-area-x)+1em)]">
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <UnoIcon className="size-5" />
          <span>Uno Work</span>
          <span className="ml-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
            Setup
          </span>
        </div>
        <div className="ml-auto">
          {showSkip && (
            <Button variant="ghost" size="xs" onClick={onSkip}>
              Skip setup
            </Button>
          )}
        </div>
      </header>

      <div className="relative h-[3px] shrink-0 bg-muted">
        <div
          className="h-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <main className="flex flex-1 overflow-hidden">
        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col overflow-y-auto px-10 py-12 sm:px-14">
          {children}
        </div>
      </main>

      <footer className="flex h-18 shrink-0 items-center gap-3 border-t border-border px-6 py-3">
        {!isFirst ? (
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
        ) : null}

        <div className="flex flex-1 justify-center">
          <div className="flex items-center gap-1.5">
            {visibleStepIds.map((id, i) => (
              <span
                key={id}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  i === stepIndex
                    ? "w-4 bg-primary"
                    : i < stepIndex
                      ? "w-1.5 bg-primary/40"
                      : "w-1.5 bg-border",
                )}
                aria-hidden
              />
            ))}
          </div>
        </div>

        <Button variant="default" size="sm" onClick={onContinue} disabled={!canContinue}>
          {computedContinueLabel}
        </Button>
        <span className="sr-only">
          Step {stepIndex + 1} of {totalSteps}: {stepId}
        </span>
      </footer>
    </div>
  );
}
