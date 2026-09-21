/**
 * Small building blocks shared by the "This computer" sections: a section
 * card, the calm "coming soon" and "asleep" states, and a copy button.
 */
import type { UnoComputerAvailability } from "@t3tools/contracts";
import { CheckIcon, CopyIcon, SparklesIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export function SectionCard({
  title,
  icon,
  action,
  className,
  children,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-2xl border border-border/60 bg-card/40 p-5",
        className,
      )}
    >
      <header className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:size-3.5">
          {icon}
        </span>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {action ? <div className="ml-auto flex items-center gap-1">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}

/**
 * What a section says when it has nothing live to show. Never red: a route
 * that is not deployed yet is "coming soon", a sleeping computer is asleep.
 */
export function QuietState({
  availability,
  message,
  soon,
  offline,
}: {
  availability: UnoComputerAvailability;
  message: string | null;
  soon: string;
  offline: string;
}) {
  if (availability === "unavailable") {
    return (
      <div className="flex items-start gap-2.5 rounded-xl bg-muted/40 px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">
        <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
        <span>
          <span className="font-medium text-foreground">Coming soon.</span> {soon}
        </span>
      </div>
    );
  }
  if (availability === "offline") {
    return <p className="text-xs leading-relaxed text-muted-foreground">{offline}</p>;
  }
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      {message ?? "Couldn't read this just now. It will try again in a moment."}
    </p>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => copyToClipboard(value)}
      aria-label={`Copy ${label}`}
    >
      {isCopied ? <CheckIcon /> : <CopyIcon />}
      {isCopied ? "Copied" : "Copy"}
    </Button>
  );
}

export function Meter({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500",
          value >= 90 ? "bg-destructive" : value >= 70 ? "bg-warning" : "bg-primary",
        )}
        style={{ width: `${Math.max(2, value)}%` }}
      />
    </div>
  );
}
