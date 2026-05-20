import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export function StepEyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
      {children}
    </div>
  );
}

export function StepTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{children}</h2>
  );
}

export function StepLead({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 max-w-xl text-base leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

export function FeatureBullet({
  icon,
  children,
}: {
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 text-sm leading-relaxed">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        {icon}
      </span>
      <span>{children}</span>
    </li>
  );
}

export function TwoColumn({
  children,
  className,
  screenshotEmphasis = false,
}: {
  children: ReactNode;
  className?: string;
  screenshotEmphasis?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid flex-1 items-center gap-10",
        screenshotEmphasis
          ? "lg:grid-cols-[1fr_1.55fr]"
          : "lg:grid-cols-[1fr_1.15fr]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function StepScreenshot({
  src,
  alt,
  variant = "cover",
}: {
  src: string;
  alt: string;
  variant?: "cover" | "contain" | "dark";
}) {
  return (
    <div
      className={cn(
        "relative aspect-[16/10] overflow-hidden rounded-2xl border border-border",
        variant === "dark" ? "bg-neutral-950" : "bg-muted/40",
      )}
    >
      <img
        src={src}
        alt={alt}
        className={cn(
          "absolute inset-0 size-full",
          variant === "contain" ? "object-contain p-6" : "object-cover object-left-top",
        )}
        onError={(event) => {
          (event.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    </div>
  );
}
