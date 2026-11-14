/**
 * The frame every setup step sits in: the app's own sidebar stays on the
 * left (so "Set up N/8" — "N/3" on the developer way — and the new project
 * are visible while you work),
 * with a header, the step strip, the page and a footer with Back / Skip /
 * the step's main action.
 */
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CheckIcon,
  FolderGit2Icon,
  Loader2Icon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import {
  flowOfStep,
  previousStep,
  setupStepLabel,
  stepsOfFlow,
  type AnySetupStepId,
} from "./setupModel";
import { useSetupProgress } from "./useSetupProgress";
import { useSetupNavigation } from "./useSetupNavigation";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";

export interface SetupPrimaryAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly pending?: boolean;
}

export function SetupFrame({
  title,
  icon = true,
  Icon = SparklesIcon,
  progress,
  headerAction,
  children,
  footer,
}: {
  title: string;
  /** The sparkle before the title (the steps have it, the welcome screen doesn't). */
  icon?: boolean;
  /** Which one: the developer way has its folder. */
  Icon?: LucideIcon;
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
          <SidebarShowButton />
          {icon ? <Icon className="size-4 text-muted-foreground" aria-hidden /> : null}
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

function StepStrip({ current }: { current: AnySetupStepId }) {
  const progress = useSetupProgress();
  const { goToStep } = useSetupNavigation();
  const steps = stepsOfFlow(flowOfStep(current));
  const index = steps.indexOf(current);
  return (
    <>
      <nav
        aria-label="Setup steps"
        className="hidden flex-wrap gap-1 px-5 pt-4 lg:flex"
        data-testid="setup-stepper"
      >
        {steps.map((step, k) => {
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
              {setupStepLabel(step)}
            </button>
          );
        })}
      </nav>
      <div className="px-5 pt-4 text-xs text-muted-foreground lg:hidden">
        Step <b className="text-foreground">{index + 1}</b> of {steps.length} ·{" "}
        <b className="text-foreground">{setupStepLabel(current)}</b>
      </div>
    </>
  );
}

/**
 * One step of either way (the eight steps, or the developer's three). `primary`
 * is the step's main button (none while the step itself has nothing to press);
 * Continue marks the step done, Skip marks it skipped — both move on.
 */
export function SetupShell({
  step,
  primary,
  wide = false,
  canSkip = true,
  children,
}: {
  step: AnySetupStepId;
  primary?: SetupPrimaryAction | null;
  wide?: boolean;
  canSkip?: boolean;
  children: ReactNode;
}) {
  const { goToStep, goHome, skipStep, skipAll, one } = useSetupNavigation();
  const navigate = useNavigate();
  const dev = flowOfStep(step) === "dev";
  const steps = stepsOfFlow(flowOfStep(step));
  const index = steps.indexOf(step);
  const last = index === steps.length - 1;
  // On its own (Home's Next step card, `one=1`): no strip, no "Skip setup",
  // no Back into other steps — Home is the way back.
  const back = one ? null : previousStep(step);
  // The first step goes back to where the way was picked.
  const firstBack = one || back ? null : dev ? "start" : step === "ai" ? "welcome" : null;
  return (
    <SetupFrame
      title={dev ? "Move your projects here" : "Set up your computer"}
      {...(dev ? { Icon: FolderGit2Icon } : {})}
      progress={one ? null : (index + 1) / steps.length}
      headerAction={
        one ? (
          <Button size="xs" variant="ghost" onClick={goHome}>
            Back to Home
          </Button>
        ) : !last ? (
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
          ) : firstBack ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void navigate({ to: "/setup", search: { step: firstBack } })}
            >
              Back
            </Button>
          ) : null}
          <span className="flex-1" />
          {!last ? (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              You can change all of this later
            </span>
          ) : null}
          {/* The eight steps end on a summary; the developer's last step can wait. */}
          {canSkip && (!last || dev) ? (
            <Button size="sm" variant="ghost" onClick={() => void skipStep(step)}>
              {one ? "Not now" : "Skip"}
            </Button>
          ) : null}
          {primary ? (
            <Button
              size="sm"
              // Wrapped under Back / Skip on a phone: it still sits on the right.
              className="ml-auto"
              onClick={primary.onClick}
              disabled={primary.disabled === true || primary.pending === true}
              data-testid="setup-primary"
            >
              {primary.pending ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
              {primary.label}
              {primary.pending ? null : <ArrowRightIcon className="size-3.5" />}
            </Button>
          ) : null}
        </>
      }
    >
      {one ? null : <StepStrip current={step} />}
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
