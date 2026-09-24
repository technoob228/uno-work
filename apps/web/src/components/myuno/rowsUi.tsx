/**
 * The small parts the My Uno rows are built from: one ~44px line per thing
 * (click → the side panel, its one action on the right), filter chips, a
 * search box, group titles and app chips.
 */
import { SearchIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ComputerApp } from "../../account/accountOverview";
import { cn } from "../../lib/utils";
import { appHealth, type StateTone } from "./myUnoModel";

export const TONE_DOT: Record<StateTone, string> = {
  ok: "bg-success",
  idle: "bg-info",
  busy: "animate-pulse bg-warning",
  bad: "bg-destructive",
  off: "bg-muted-foreground/40",
};

export function Dot({ tone, className }: { tone: StateTone; className?: string }) {
  return (
    <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[tone], className)} aria-hidden />
  );
}

export function Chip({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs transition-colors",
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
      {count !== undefined ? <span className="tabular-nums opacity-60">{count}</span> : null}
    </button>
  );
}

export function SearchBox({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex h-7 min-w-0 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs focus-within:border-ring",
        className,
      )}
    >
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onChange("");
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="text-muted-foreground hover:text-foreground"
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </label>
  );
}

export function GroupTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 px-1 pt-2 pb-0.5">
      <h3 className="text-xs font-medium text-muted-foreground">{children}</h3>
      {right ? (
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{right}</span>
      ) : null}
    </div>
  );
}

export function RowList({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <ul
      className="overflow-hidden rounded-2xl border border-border/60 bg-card/30"
      data-testid={testId}
    >
      {children}
    </ul>
  );
}

/** One line per thing: click → the side panel; its one action on the right. */
export function Row({
  selected,
  dim,
  bad,
  onSelect,
  action,
  label,
  testId,
  children,
}: {
  selected: boolean;
  dim?: boolean;
  bad?: boolean;
  onSelect: () => void;
  action?: ReactNode;
  label: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "group flex h-11 items-center gap-3 border-b border-border/50 pr-2 pl-3 text-sm last:border-0",
        selected ? "bg-primary/8" : bad ? "bg-destructive/[0.04]" : "hover:bg-accent/40",
        dim && !selected && "text-muted-foreground",
      )}
      data-testid={testId}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-label={label}
        aria-expanded={selected}
        className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {children}
      </button>
      {action ? <span className="flex shrink-0 items-center gap-0.5">{action}</span> : null}
    </li>
  );
}

/** Shown on hover or keyboard focus of the row; always shown on touch. */
export const HOVER_ONLY =
  "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100";

export function AppGlyph({ app, className }: { app: ComputerApp; className?: string }) {
  const image = app.icon.startsWith("http");
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full bg-background text-[9px] leading-none",
        className,
      )}
      aria-hidden
    >
      {image ? (
        <img src={app.icon} alt="" className="size-full object-cover" />
      ) : (
        app.icon || app.name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}

/** An App Store app inside its computer's row; red when it didn't install. */
export function AppChip({ app, paused }: { app: ComputerApp; paused: boolean }) {
  const health = appHealth(app.status);
  return (
    <span
      className={cn(
        "flex h-5 shrink-0 items-center gap-1 rounded-full pr-1.5 pl-0.5 text-[11px]",
        health === "failed"
          ? "bg-destructive/10 text-destructive-foreground"
          : "bg-muted/70 text-foreground/80",
        (paused || health === "stopped" || health === "installing") &&
          health !== "failed" &&
          "opacity-60",
      )}
      title={health === "running" ? app.name : `${app.name} · ${health}`}
    >
      <AppGlyph app={app} />
      {app.name}
    </span>
  );
}
