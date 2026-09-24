/**
 * Small shared pieces: status dots, project and app glyphs, inbox kind
 * icons, the page header, time labels and the toasts. Look copied from the
 * real 0.0.81 sidebar and Inbox panel.
 */
import {
  AppWindowIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { APPS, type InboxItem, type Project, type Thread } from "../data";
import { useProto } from "../store";

export const rowBase =
  "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-hidden transition-colors";
export const rowIdle = "text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground";
export const rowActive = "bg-sidebar-row-active text-foreground";

export function Dot({ className }: { className?: string }) {
  return <span className={cn("inline-block size-1.5 shrink-0 rounded-full", className)} aria-hidden />;
}

export const STATUS_DOT: Record<Thread["status"], string> = {
  approval: "bg-amber-500",
  input: "bg-indigo-500",
  working: "animate-pulse bg-sky-500",
  done: "bg-emerald-500",
  idle: "bg-muted-foreground/30",
  failed: "bg-destructive",
};

export function ThreadDot({ thread }: { thread: Thread }) {
  const quiet = (thread.status === "done" || thread.status === "failed") && !thread.unseen;
  return <Dot className={quiet ? "bg-muted-foreground/30" : STATUS_DOT[thread.status]} />;
}

export function statusLabel(t: Thread): { text: string; tone: string } {
  if (t.draft) return { text: "draft", tone: "text-muted-foreground/70" };
  if (t.status === "approval" || t.status === "input") return { text: "needs you", tone: "text-amber-600" };
  if (t.status === "working") return { text: "working", tone: "text-sky-600" };
  if (t.status === "failed" && t.unseen) return { text: "failed", tone: "text-destructive-foreground" };
  return { text: ago(t.updatedMin), tone: "text-muted-foreground/80" };
}

export function ago(min: number): string {
  if (min < 1) return "now";
  if (min < 60) return `${min} min`;
  if (min < 60 * 24) return `${Math.round(min / 60)} h`;
  const d = Math.round(min / 60 / 24);
  return d === 1 ? "yesterday" : `${d} d`;
}

export function ProjectGlyph({ project, className }: { project: Project; className?: string }) {
  return (
    <span
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-md text-[10px] font-semibold",
        project.tint,
        className,
      )}
      aria-hidden
    >
      {project.glyph}
    </span>
  );
}

export function AppGlyph({ appId, className }: { appId: string; className?: string | undefined }) {
  const app = APPS.find((a) => a.id === appId) ?? APPS[0]!;
  return (
    <span
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md bg-gradient-to-br text-[9px] font-semibold text-white shadow-sm ring-1 ring-black/5",
        app.color,
        className,
      )}
      aria-hidden
    >
      {app.glyph}
    </span>
  );
}

export function appName(appId: string): string {
  return APPS.find((a) => a.id === appId)?.name ?? appId;
}

export function InboxKindIcon({ item, className }: { item: InboxItem; className?: string }) {
  if (item.kind === "app" && item.appId) return <AppGlyph appId={item.appId} className={className} />;
  const map: Record<Exclude<InboxItem["kind"], "app">, { icon: ReactNode; tint: string }> = {
    approval: { icon: <ShieldQuestionIcon />, tint: "bg-amber-500/12 text-amber-600" },
    input: { icon: <MessageCircleQuestionIcon />, tint: "bg-indigo-500/12 text-indigo-600" },
    done: { icon: <CircleCheckIcon />, tint: "bg-emerald-500/12 text-emerald-600" },
    failed: { icon: <CircleAlertIcon />, tint: "bg-destructive/10 text-destructive-foreground" },
  };
  const k = map[item.kind as Exclude<InboxItem["kind"], "app">] ?? { icon: <AppWindowIcon />, tint: "" };
  return (
    <span className={cn("grid size-6 shrink-0 place-items-center rounded-md [&_svg]:size-3.5", k.tint, className)} aria-hidden>
      {k.icon}
    </span>
  );
}

export function CountBadge({ unread, needsYou, className }: { unread: number; needsYou: number; className?: string }) {
  if (unread <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-4.5 items-center justify-center rounded-full px-1 text-[10px] leading-4.5 font-semibold tabular-nums",
        needsYou > 0 ? "bg-warning text-warning-foreground" : "bg-primary text-primary-foreground",
        className,
      )}
    >
      {unread}
    </span>
  );
}

export function PageHeader({ icon, title, children, right }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; right?: ReactNode }) {
  return (
    <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-5">
      {icon ? <span className="text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
      <span className="min-w-0 truncate text-sm font-medium text-foreground">{title}</span>
      {children}
      <div className="ml-auto flex items-center gap-1.5">{right}</div>
    </header>
  );
}

export function Toaster() {
  const toasts = useProto((s) => s.toasts);
  const dismiss = useProto((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed top-4 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-popover p-3 text-sm shadow-lg/5">
          <span className="mt-0.5 [&_svg]:size-4">
            {t.title.toLowerCase().includes("not part") ? <InfoIcon className="text-info" /> : <CheckCircle2Icon className="text-success" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t.title}</div>
            {t.description ? <div className="text-xs text-muted-foreground">{t.description}</div> : null}
          </div>
          <button type="button" onClick={() => dismiss(t.id)} className="text-muted-foreground hover:text-foreground">
            <XIcon className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function TelegramGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-3.5", className)} aria-hidden>
      <circle cx="12" cy="12" r="12" fill="#29A9EB" />
      <path d="M5.4 11.8l11-4.3c.5-.2 1 .1.8.9l-1.9 8.8c-.1.6-.5.8-1 .5l-2.8-2.1-1.4 1.3c-.2.2-.3.3-.6.3l.2-2.9 5.3-4.8c.2-.2 0-.3-.3-.1l-6.6 4.1-2.8-.9c-.6-.2-.6-.6.1-.8z" fill="#fff" />
    </svg>
  );
}

export function SlackGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-3.5", className)} aria-hidden>
      <rect x="10" y="2" width="4" height="9" rx="2" fill="#36C5F0" />
      <rect x="13" y="10" width="9" height="4" rx="2" fill="#2EB67D" />
      <rect x="10" y="13" width="4" height="9" rx="2" fill="#ECB22E" />
      <rect x="2" y="10" width="9" height="4" rx="2" fill="#E01E5A" />
    </svg>
  );
}
