/**
 * The overlay of "Connect my computer" and its heading. One card at a time:
 * a confirmation replaces the card it came from, so Escape has one meaning.
 */
import { XIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import { cn } from "../../lib/utils";
import { localComputer } from "../../localComputer/localComputerStore";

const TITLE_ID = "connect-computer-title";

export function Shell({
  children,
  testId,
  onEscape = localComputer.close,
  closeButton = false,
}: {
  children: ReactNode;
  testId: string;
  onEscape?: () => void;
  /** For a card with no buttons of its own: the way out without a keyboard. */
  closeButton?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, [testId]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscape]);
  return (
    <div className="fixed inset-0 z-50 flex overflow-y-auto bg-black/32 p-4 backdrop-blur-sm">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        tabIndex={-1}
        data-testid={testId}
        className="relative m-auto flex w-full max-w-md flex-col gap-4 rounded-2xl border bg-popover p-6 text-popover-foreground shadow-lg/5 outline-none"
      >
        {closeButton ? (
          <button
            type="button"
            aria-label="Close"
            onClick={localComputer.close}
            data-testid="connect-x"
            className="absolute top-3 right-3 grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <XIcon className="size-4" />
          </button>
        ) : null}
        {children}
      </div>
    </div>
  );
}

export function Heading({
  icon,
  title,
  tone = "primary",
}: {
  icon: ReactNode;
  title: string;
  tone?: "primary" | "ok" | "warning";
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-xl",
          tone === "primary" && "bg-primary/12 text-primary",
          tone === "ok" && "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
          tone === "warning" && "bg-amber-500/14 text-amber-600 dark:text-amber-400",
        )}
      >
        {icon}
      </div>
      <h2 id={TITLE_ID} className="font-heading text-lg leading-tight font-semibold">
        {title}
      </h2>
    </div>
  );
}
