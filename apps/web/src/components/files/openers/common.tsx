import { Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { FILE_KIND_ICON, FILE_KIND_TINT, type FileKind } from "../fileTypes";

export function ViewerLoading({ label = "Opening…" }: { label?: string }) {
  return (
    <div className="flex h-full min-h-60 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2Icon className="size-4 animate-spin" />
      {label}
    </div>
  );
}

export function ViewerMessage({
  kind,
  title,
  children,
  tone = "neutral",
}: {
  kind: FileKind;
  title: string;
  children?: ReactNode;
  tone?: "neutral" | "error";
}) {
  const Icon = FILE_KIND_ICON[kind];
  return (
    <div className="flex h-full min-h-72 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-muted/60">
        <Icon className={cn("size-8", FILE_KIND_TINT[kind])} />
      </div>
      <div
        className={cn(
          "text-base font-medium",
          tone === "error" ? "text-destructive" : "text-foreground",
        )}
      >
        {title}
      </div>
      {children ? (
        <div className="max-w-md text-sm leading-relaxed text-muted-foreground">{children}</div>
      ) : null}
    </div>
  );
}

export function viewerErrorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

/** A sheet of paper on the desk: how documents sit in the viewer. */
export function Paper({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="px-3 py-6 sm:px-8">
      <div
        className={cn(
          "mx-auto w-full max-w-3xl rounded-xl border border-border/60 bg-card px-6 py-8 shadow-sm sm:px-12 sm:py-12",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
