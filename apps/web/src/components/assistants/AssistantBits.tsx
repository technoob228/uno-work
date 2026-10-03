/** Small pieces shared by the Assistants screens (assistants MVP). */
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import {
  ASSISTANT_STATUS_LABEL,
  CONNECTOR_LEVELS,
  LEVEL_LABEL,
  type AssistantStatus,
  type ConnectorLevel,
} from "./assistantTemplates";

export function EmojiAvatar({
  emoji,
  className,
  onClick,
  title,
}: {
  emoji: string;
  className?: string;
  onClick?: () => void;
  title?: string;
}) {
  const classes = cn(
    "grid size-10 shrink-0 place-items-center rounded-xl bg-accent/60 text-xl leading-none",
    onClick && "cursor-pointer transition-colors hover:bg-accent",
    className,
  );
  return onClick ? (
    <button type="button" className={classes} onClick={onClick} title={title} aria-label={title}>
      {emoji}
    </button>
  ) : (
    <span aria-hidden className={classes}>
      {emoji}
    </span>
  );
}

const STATUS_TONE: Record<AssistantStatus, string> = {
  waiting: "bg-warning/12 text-warning-foreground [&>span]:bg-warning",
  working: "bg-success/12 text-success-foreground [&>span]:bg-success",
  awake: "bg-success/8 text-muted-foreground [&>span]:bg-success",
  asleep: "bg-muted text-muted-foreground [&>span]:bg-muted-foreground/50",
  starting: "bg-muted text-muted-foreground [&>span]:bg-muted-foreground/50",
};

export function StatusPill({ status }: { status: AssistantStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
        STATUS_TONE[status],
      )}
      data-testid={`assistant-status-${status}`}
    >
      <span className="size-1.5 rounded-full" aria-hidden />
      {ASSISTANT_STATUS_LABEL[status]}
    </span>
  );
}

/** none / read / write as three buttons; the console checks it on every call. */
export function LevelPicker({
  value,
  onChange,
  disabled,
  testId,
}: {
  value: ConnectorLevel;
  onChange: (level: ConnectorLevel) => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div
      role="radiogroup"
      className="inline-flex shrink-0 rounded-lg border border-border bg-background p-0.5"
      data-testid={testId}
    >
      {CONNECTOR_LEVELS.map((level) => (
        <button
          key={level}
          type="button"
          role="radio"
          aria-checked={value === level}
          disabled={disabled}
          onClick={() => onChange(level)}
          className={cn(
            "cursor-pointer rounded-md px-2 py-1 text-xs whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-60",
            value === level
              ? level === "none"
                ? "bg-muted font-medium text-foreground"
                : "bg-primary/10 font-medium text-primary"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {LEVEL_LABEL[level]}
        </button>
      ))}
    </div>
  );
}

export function Block({
  title,
  action,
  children,
  testId,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section className="rounded-2xl border border-border/70 px-4 py-3" data-testid={testId}>
      <div className="flex items-center gap-2 pb-1">
        <h2 className="flex-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export const EMOJI_CHOICES = [
  "🤖",
  "🗓️",
  "📣",
  "🛡️",
  "💬",
  "🦉",
  "🦊",
  "🐝",
  "🌱",
  "⚡️",
  "🎯",
  "🧭",
];

export function nextEmoji(current: string): string {
  const index = EMOJI_CHOICES.indexOf(current);
  return EMOJI_CHOICES[(index + 1) % EMOJI_CHOICES.length]!;
}
