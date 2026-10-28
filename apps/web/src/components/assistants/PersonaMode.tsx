/**
 * Variant D (28.10): the two modes of an assistant (Misha 23.10, 27.10 —
 * exactly two: "Autonomous" / "Cautious"), shown where the person
 * meets them — at the top of its chat and on its page — not folded in
 * Advanced. Each persona has its own; switching counts from its next step
 * (the daemon rewrites its token), also in the middle of a task.
 *
 * And the honest plaque of the Free plan: the cloud computer Uno and the
 * personas live on sleeps when the person is away — the summary comes when
 * Work opens, Telegram messages wait — with the way to Plus.
 */
import { type EnvironmentId, isAssistantProjectId } from "@t3tools/contracts";
import { ASSISTANT_MODE_COPY } from "@t3tools/shared/assistantPreset";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, HandIcon, MoonIcon, ZapIcon } from "lucide-react";
import { useState } from "react";

import { accountRequest } from "../../account/unoAccount";
import { CHOOSE_PLAN_URL } from "../../account/planStatus";
import { setAssistantPreset } from "../../lib/managerApi";
import { useMachineLabels } from "../../hooks/useMachineRows";
import { cn } from "../../lib/utils";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../../store";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { type TeamMember, useAssistantTeam } from "./useAssistantTeam";
import { useTeamActions } from "./useTeamActions";

export type AssistantMode = "itself" | "asks-first";

/** The permission level (Misha 28.10): Autonomous / Cautious — one copy with the daemon's. */
export const MODE_COPY: Readonly<
  Record<AssistantMode, { readonly label: string; readonly line: string }>
> = {
  itself: { label: ASSISTANT_MODE_COPY.itself.name, line: ASSISTANT_MODE_COPY.itself.line },
  "asks-first": {
    label: ASSISTANT_MODE_COPY["asks-first"].name,
    line: ASSISTANT_MODE_COPY["asks-first"].line,
  },
};

export function modeOf(member: TeamMember): AssistantMode {
  return member.profile.preset === "full" ? "itself" : "asks-first";
}

/** Switches its mode; its projects stay as they are. */
export function useSetMode(member: TeamMember | null) {
  const actions = useTeamActions();
  const [saving, setSaving] = useState(false);
  const set = async (mode: AssistantMode) => {
    if (!member || saving || modeOf(member) === mode) return;
    setSaving(true);
    try {
      const allowlist = member.summary?.token?.projectAllowlist ?? "all";
      await setAssistantPreset({
        environmentId: member.environmentId as EnvironmentId,
        projectId: member.projectId,
        preset: mode === "itself" ? "full" : "helper",
        projects:
          allowlist === "all"
            ? "all"
            : allowlist.filter((id) => id !== member.projectId && !isAssistantProjectId(id)),
      });
      await actions.refresh();
      toastManager.add({
        type: "success",
        title: `${member.profile.name}: ${MODE_COPY[mode].label}`,
        description: `From its next step. ${MODE_COPY[mode].line}`,
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't change the permission level",
        description: cause instanceof Error ? cause.message : "Its computer didn't answer.",
      });
    } finally {
      setSaving(false);
    }
  };
  return { set, saving };
}

const ICON: Record<AssistantMode, typeof ZapIcon> = { itself: ZapIcon, "asks-first": HandIcon };

/** The chip at the top of its chat: "✋ Cautious ▾". */
export function AssistantModeChip(props: { readonly member: TeamMember }) {
  const { member } = props;
  const mode = modeOf(member);
  const { set, saving } = useSetMode(member);
  const Icon = ICON[mode];
  if (member.revoked) return null;
  return (
    <Menu>
      <MenuTrigger
        data-testid="assistant-mode-chip"
        disabled={saving}
        className={cn(
          "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 text-xs font-medium sm:h-6",
          mode === "asks-first"
            ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
            : "border-input text-foreground hover:bg-accent",
        )}
      >
        <Icon className="size-3.5" />
        {MODE_COPY[mode].label}
        <ChevronDownIcon className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-64">
        {(["itself", "asks-first"] as const).map((item) => {
          const ItemIcon = ICON[item];
          return (
            <MenuItem
              key={item}
              onClick={() => void set(item)}
              data-testid={`assistant-mode-${item}`}
            >
              <ItemIcon className="size-4 text-amber-500" />
              <span className="flex flex-col">
                <span className={cn("text-sm", item === mode && "font-semibold")}>
                  {MODE_COPY[item].label}
                  {item === mode ? " ✓" : ""}
                </span>
                <span className="text-xs text-muted-foreground">{MODE_COPY[item].line}</span>
              </span>
            </MenuItem>
          );
        })}
        <p className="px-2 pt-1 pb-1.5 text-[11px] leading-snug text-muted-foreground">
          Only {member.profile.name}'s permission level. Counts from its next step.
        </p>
      </MenuPopup>
    </Menu>
  );
}

/** Uno's chip, for Uno's own chats (it has one per account in variant D). */
export function UnoModeChip(props: { readonly environmentId: string }) {
  const team = useAssistantTeam();
  const uno =
    team.find((member) => member.isUno && member.environmentId === props.environmentId) ??
    team.find((member) => member.isUno) ??
    null;
  return uno ? <AssistantModeChip member={uno} /> : null;
}

/** The two modes side by side on its page. */
export function AssistantModeSwitch(props: { readonly member: TeamMember }) {
  const { member } = props;
  const mode = modeOf(member);
  const { set, saving } = useSetMode(member);
  return (
    <div className="grid gap-2 sm:grid-cols-2" data-testid="assistant-mode-switch">
      {(["itself", "asks-first"] as const).map((item) => {
        const Icon = ICON[item];
        return (
          <button
            key={item}
            type="button"
            disabled={saving || member.revoked}
            aria-pressed={item === mode}
            onClick={() => void set(item)}
            data-testid={`assistant-mode-switch-${item}`}
            className={cn(
              "flex cursor-pointer flex-col gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-default",
              item === mode
                ? "border-primary bg-primary/[0.06]"
                : "border-border hover:bg-accent/50",
            )}
          >
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <Icon className="size-4 text-amber-500" /> {MODE_COPY[item].label}
            </span>
            <span className="text-xs text-muted-foreground">{MODE_COPY[item].line}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Free: the cloud sleeps ───────────────────────────────────────────────

/** The account's plan for its cloud computer: "free" sleeps, a paid one keeps it on. */
export function useCloudPlan(): "free" | "paid" | null {
  const query = useQuery({
    queryKey: ["uno-account", "box-subscription"],
    queryFn: () => accountRequest("GET", "/api/v1/box-subscription"),
    staleTime: 60_000,
    retry: false,
  });
  const plan = (query.data as { plan?: string } | null | undefined)?.plan;
  if (!plan) return null;
  return plan === "free" ? "free" : "paid";
}

/**
 * Over an assistant's chat on Free: the cloud computer sleeps when you're
 * away, so the summary comes when Work opens and Telegram messages wait.
 */
export function CloudSleepsBanner(props: {
  readonly environmentId: string;
  readonly threadId: string;
}) {
  const plan = useCloudPlan();
  const projectId = useStore(
    (state) =>
      selectSidebarThreadsAcrossEnvironments(state).find(
        (thread) => thread.environmentId === props.environmentId && thread.id === props.threadId,
      )?.projectId ?? null,
  );
  const [hidden, setHidden] = useState(false);
  if (plan !== "free" || hidden || projectId === null || !isAssistantProjectId(projectId)) {
    return null;
  }
  return (
    <div
      className="mx-auto mt-2 flex w-[min(48rem,calc(100%-1.5rem))] items-start gap-2.5 rounded-xl border border-border bg-muted/40 px-3 py-2.5 text-xs leading-snug"
      data-testid="cloud-sleeps-banner"
    >
      <MoonIcon className="mt-0.5 size-4 shrink-0 text-violet-500" />
      <span className="min-w-0 flex-1">
        <b className="font-semibold">On Free, your cloud computer sleeps when you're away.</b> Uno
        and your helpers catch up when you open Work; Telegram messages wait until then.
      </span>
      <a
        href={CHOOSE_PLAN_URL}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground hover:bg-primary/90"
        data-testid="cloud-sleeps-plus"
      >
        Keep it on — Plus
      </a>
      <button
        type="button"
        onClick={() => setHidden(true)}
        className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
        aria-label="Hide"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Whose and where an Inbox item is (variant D, audit 27.10 #9): the
 * computer's name when there is more than one, and the persona when the chat
 * is one of a persona's — "Mia · uno-work", "MacBook".
 */
export function useInboxWho(environmentId: string, threadId: string | null): string | null {
  const team = useAssistantTeam();
  const labels = useMachineLabels();
  const projectId = useStore((state) =>
    threadId === null
      ? null
      : (selectSidebarThreadsAcrossEnvironments(state).find(
          (thread) => thread.environmentId === environmentId && thread.id === threadId,
        )?.projectId ?? null),
  );
  const persona =
    projectId === null
      ? null
      : (team.find(
          (member) =>
            !member.isUno &&
            member.environmentId === environmentId &&
            member.projectId === projectId,
        ) ?? null);
  const machine = labels.size > 1 ? (labels.get(environmentId) ?? null) : null;
  const parts = [persona?.profile.name ?? null, machine ? `on ${machine}` : null].filter(
    (part): part is string => part !== null,
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}
