/**
 * The pieces of an assistant's page (w0138 p7) both versions use: the titled
 * card, a labelled row, a pill, a chat line, a memory file that unfolds, and
 * a branch of the team tree. The real page is `AssistantProfileSimple.tsx`,
 * the mock's is `AssistantProfilePage.tsx`.
 */
import type { AssistantEditableFileName, EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon, FileTextIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { readAssistantFile } from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { AssistantAvatar, avatarImageOf } from "./AssistantAvatar";
import { type AssistantTreeNode, PRESET_NAME } from "./assistantTeam.logic";
import { type TeamMember, threadActivityMs } from "./useAssistantTeam";

export function Section(props: {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly testId?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-2", props.className)} data-testid={props.testId}>
      <div className="flex h-6 items-center justify-between gap-2 px-1">
        <h2 className="text-[13px] font-medium text-foreground">{props.title}</h2>
        {props.action}
      </div>
      <div className="rounded-lg border border-border bg-card/40">{props.children}</div>
    </section>
  );
}

export function Row(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly last?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[7.5rem_1fr] items-start gap-3 px-3 py-2 text-sm",
        !props.last && "border-b border-border/70",
      )}
    >
      <span className="pt-px text-xs text-muted-foreground">{props.label}</span>
      <div className="min-w-0">{props.children}</div>
    </div>
  );
}

export function Pill(props: { readonly children: ReactNode; readonly muted?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 text-xs",
        props.muted ? "border-border text-muted-foreground" : "border-border bg-muted/50",
      )}
    >
      {props.children}
    </span>
  );
}

export function ChatLine(props: {
  readonly thread: SidebarThreadSummary;
  readonly onOpen: () => void;
}) {
  const status = resolveSidebarThreadStatus(props.thread);
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex h-8 w-full cursor-pointer items-center gap-2 border-b border-border/70 px-3 text-left text-sm last:border-b-0 hover:bg-accent/40"
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          status === "working"
            ? "bg-sky-500"
            : status === "approval" || status === "input"
              ? "bg-amber-500"
              : status === "failed"
                ? "bg-destructive"
                : "bg-muted-foreground/30",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{props.thread.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatRelativeTimeLabel(new Date(threadActivityMs(props.thread)).toISOString())}
      </span>
    </button>
  );
}

export function MemoryFile(props: {
  readonly member: TeamMember;
  readonly name: AssistantEditableFileName;
  readonly what: string;
  readonly last?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const file = useQuery({
    queryKey: [
      "assistant-file-preview",
      props.member.environmentId,
      props.member.projectId,
      props.name,
    ],
    queryFn: () =>
      readAssistantFile({
        environmentId: props.member.environmentId as EnvironmentId,
        projectId: props.member.projectId,
        name: props.name,
      }),
    retry: false,
    staleTime: 60_000,
  });
  const lines = (file.data?.content ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, open ? undefined : 3);
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      className={cn(
        "flex w-full cursor-pointer items-start gap-2.5 px-3 py-2 text-left hover:bg-accent/40",
        !props.last && "border-b border-border/70",
      )}
    >
      <FileTextIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 text-sm">
          <span className="font-medium">{props.name}</span>
          <span className="text-xs text-muted-foreground">{props.what}</span>
        </span>
        {file.isLoading ? (
          <span className="block text-xs text-muted-foreground">…</span>
        ) : lines.length > 0 ? (
          lines.map((line) => (
            <span
              key={line}
              className={cn("block text-xs text-muted-foreground", !open && "truncate")}
            >
              {line}
            </span>
          ))
        ) : (
          <span className="block text-xs text-muted-foreground">
            {file.isError ? "Opens when its computer is awake." : "Empty so far."}
          </span>
        )}
      </span>
      <ChevronRightIcon
        className={cn(
          "mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform",
          open && "rotate-90",
        )}
      />
    </button>
  );
}

export function TreeBranch(props: {
  readonly node: AssistantTreeNode<TeamMember>;
  readonly current: string;
  readonly onOpen: (member: TeamMember) => void;
}) {
  const { item } = props.node;
  return (
    <div>
      <button
        type="button"
        onClick={() => props.onOpen(item)}
        className={cn(
          "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent/40",
          item.key === props.current && "bg-accent/60",
        )}
      >
        <AssistantAvatar
          emoji={item.profile.emoji}
          image={avatarImageOf(item.profile)}
          tone={item.profile.tone}
          activity={item.activity}
          revoked={item.revoked}
          className="size-4.5"
          emojiClassName="text-[10px]"
        />
        <span className={cn("truncate", item.revoked && "text-muted-foreground line-through")}>
          {item.profile.name}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {item.revoked ? "revoked" : PRESET_NAME[item.profile.preset]}
        </span>
      </button>
      {props.node.children.length > 0 ? (
        // Who it set up: indented under a line, not ASCII (critics D20).
        <div className="ml-[1.06rem] border-l border-border pl-2">
          {props.node.children.map((child) => (
            <TreeBranch
              key={child.item.key}
              node={child}
              current={props.current}
              onOpen={props.onOpen}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
