/**
 * The frame every setup step sits in: the app's own sidebar stays on the
 * left (so "Set up N/8" and the new project are visible while you work),
 * with a header, the step strip, the page and a footer with Back / Skip /
 * the step's main action.
 */
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, CheckIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { SETUP_STEPS, SETUP_STEP_LABEL, previousStep, type SetupStepId } from "./setupModel";
import { useSetupProgress } from "./useSetupProgress";
import { useSetupNavigation } from "./useSetupNavigation";

export interface SetupPrimaryAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly pending?: boolean;
}

export function SetupFrame({
  title,
  icon = true,
  progress,
  headerAction,
  children,
  footer,
}: {
  title: string;
  /** The sparkle before the title (the steps have it, the welcome screen doesn't). */
  icon?: boolean;
  /** 0..1, or null for no bar. */
  progress: number | null;
  headerAction?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-5">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          {icon ? <SparklesIcon className="size-4 text-muted-foreground" aria-hidden /> : null}
          <span className="truncate text-sm font-medium">{title}</span>
          <div className="ml-auto flex items-center gap-1">{headerAction}</div>
        </header>
        {progress !== null ? (
          <div className="h-[3px] shrink-0 bg-muted" aria-hidden>
            <div
              className="h-full bg-primary transition-[width] duration-300 ease-out"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="setup-scroll">
          {children}
        </div>
        {footer ? (
          <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-3 py-3 sm:px-5">
            {footer}
          </footer>
        ) : null}
      </div>
    </SidebarInset>
  );
}

function StepStrip({ current }: { current: SetupStepId }) {
  const progress = useSetupProgress();
  const { goToStep } = useSetupNavigation();
  const index = SETUP_STEPS.indexOf(current);
  return (
    <>
      <nav
        aria-label="Setup steps"
        className="hidden flex-wrap gap-1 px-5 pt-4 lg:flex"
        data-testid="setup-stepper"
      >
        {SETUP_STEPS.map((step, k) => {
          const isCurrent = step === current;
          const skipped = progress.skipped.includes(step);
          const done = !isCurrent && !skipped && progress.visited.includes(step);
          return (
            <button
              key={step}
              type="button"
              onClick={() => goToStep(step)}
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "flex h-8 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors",
                isCurrent
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-[18px] items-center justify-center rounded-full border text-[10px] font-semibold",
                  done
                    ? "border-primary bg-primary text-primary-foreground"
                    : isCurrent
                      ? "border-primary text-primary"
                      : "border-border",
                  skipped && "border-dashed",
                )}
              >
                {done ? <CheckIcon className="size-3" strokeWidth={3} /> : k + 1}
              </span>
              {SETUP_STEP_LABEL[step]}
            </button>
          );
        })}
      </nav>
      <div className="px-5 pt-4 text-xs text-muted-foreground lg:hidden">
        Step <b className="text-foreground">{index + 1}</b> of {SETUP_STEPS.length} ·{" "}
        <b className="text-foreground">{SETUP_STEP_LABEL[current]}</b>
      </div>
    </>
  );
}

/**
 * One step. `primary` is the step's main button; Continue marks the step
 * done, Skip marks it skipped — both move on.
 */
export function SetupShell({
  step,
  primary,
  wide = false,
  canSkip = true,
  children,
}: {
  step: SetupStepId;
  primary: SetupPrimaryAction;
  wide?: boolean;
  canSkip?: boolean;
  children: ReactNode;
}) {
  const { goToStep, skipStep, skipAll } = useSetupNavigation();
  const navigate = useNavigate();
  const index = SETUP_STEPS.indexOf(step);
  const back = previousStep(step);
  return (
    <SetupFrame
      title="Set up your computer"
      progress={(index + 1) / SETUP_STEPS.length}
      headerAction={
        step !== "done" ? (
          <Button size="xs" variant="ghost" onClick={() => void skipAll()}>
            Skip setup
          </Button>
        ) : null
      }
      footer={
        <>
          {back ? (
            <Button size="sm" variant="ghost" onClick={() => goToStep(back)}>
              Back
            </Button>
          ) : step === "ai" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void navigate({ to: "/setup", search: { step: "welcome" } })}
            >
              Back
            </Button>
          ) : null}
          <span className="flex-1" />
          {step !== "done" ? (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              You can change all of this later
            </span>
          ) : null}
          {canSkip && step !== "done" ? (
            <Button size="sm" variant="ghost" onClick={() => void skipStep(step)}>
              Skip
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={primary.onClick}
            disabled={primary.disabled === true || primary.pending === true}
            data-testid="setup-primary"
          >
            {primary.pending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            {primary.label}
            {primary.pending ? null : <ArrowRightIcon className="size-3.5" />}
          </Button>
        </>
      }
    >
      <StepStrip current={step} />
      <div
        className={cn("mx-auto w-full px-5 pt-8 pb-12 sm:px-8", wide ? "max-w-6xl" : "max-w-3xl")}
      >
        {children}
      </div>
    </SetupFrame>
  );
}

export function SetupHeading({ title, lead }: { title: string; lead?: ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-[28px]">{title}</h2>
      {lead ? (
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">{lead}</p>
      ) : null}
    </div>
  );
}

export function SetupNote({ children }: { children: ReactNode }) {
  return <p className="mt-4 text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

export function ConnectedBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
      <span className="size-1.5 rounded-full bg-success" aria-hidden />
      {children}
    </span>
  );
}

export function SoonBadge() {
  return (
    <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      Soon
    </span>
  );
}
