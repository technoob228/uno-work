/**
 * Variant B (28.10): the three things a person changes on an assistant, at
 * the top of its page instead of under Advanced — where it lives (and what it
 * sees), how it works (the two modes, Misha 23.10), and remove. Changing the
 * mode or removing it while it works says what happens to that work.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { HandIcon, MonitorIcon, UserRoundXIcon, ZapIcon } from "lucide-react";
import { useState } from "react";

import { setAssistantPreset } from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import type { SidebarThreadSummary } from "../../types";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { TeamMember } from "./useAssistantTeam";
import { useTeamActions } from "./useTeamActions";
import { assistantFullName } from "./perMachine";

type Mode = "itself" | "asks-first";

const MODES: ReadonlyArray<{
  readonly id: Mode;
  readonly name: string;
  readonly line: string;
  readonly Icon: typeof ZapIcon;
}> = [
  {
    id: "itself",
    name: "Does it itself",
    line: "Acts right away, tells you after.",
    Icon: ZapIcon,
  },
  {
    id: "asks-first",
    name: "Asks first",
    line: "Shows what it's about to do, waits for your Allow.",
    Icon: HandIcon,
  },
];

export function AssistantBasics(props: {
  readonly member: TeamMember;
  readonly machineLabel: string;
  /** Its chats that run or wait right now. */
  readonly running: ReadonlyArray<SidebarThreadSummary>;
  readonly onRemoved: () => void;
}) {
  const { member, running } = props;
  const actions = useTeamActions();
  const name = member.profile.name;
  const full = assistantFullName(name, props.machineLabel);
  const mode: Mode = member.profile.preset === "full" ? "itself" : "asks-first";
  const [saving, setSaving] = useState<Mode | null>(null);
  const [confirm, setConfirm] = useState(false);
  const busy = running.length > 0;
  // Its main chat is named after it: then it's just "a task".
  const title = running[0]?.title ?? null;
  const task = title && title !== name ? `“${title}”` : "a task";

  const setMode = async (next: Mode) => {
    if (next === mode || saving) return;
    setSaving(next);
    try {
      await setAssistantPreset({
        environmentId: member.environmentId as EnvironmentId,
        projectId: member.projectId,
        preset: next === "itself" ? "full" : "helper",
        projects: "all",
      });
      await actions.refresh();
      toastManager.add({
        type: "success",
        title: `${name}: ${next === "itself" ? "Does it itself" : "Asks first"}`,
        description: busy
          ? `From its next step in ${task}. What already waits for your Allow still waits.`
          : "From its next step.",
      });
    } catch {
      toastManager.add({
        type: "error",
        title: "Couldn't change the mode",
        description: `${props.machineLabel} didn't answer. Try again in a minute.`,
      });
    } finally {
      setSaving(null);
    }
  };

  const remove = async () => {
    setConfirm(false);
    try {
      await actions.revoke(member);
      toastManager.add({
        type: "success",
        title: `${full} is removed`,
        description: busy
          ? `It stopped ${task}. Its chats stay in the sidebar.`
          : "Its chats stay. Bring it back from its page any time.",
      });
      props.onRemoved();
    } catch {
      toastManager.add({
        type: "error",
        title: `Couldn't remove ${name}`,
        description: `${props.machineLabel} didn't answer.`,
      });
    }
  };

  return (
    <section
      className="flex flex-col divide-y divide-border/70 rounded-xl border border-border"
      data-testid="assistant-basics"
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Lives on {props.machineLabel}</div>
          <div className="text-xs text-muted-foreground">
            Sees only {props.machineLabel}: its files, chats and apps. Your other computers have
            their own assistants.
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2 px-4 py-3">
        <div className="text-sm font-medium">How it works</div>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="How it works">
          {MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={mode === item.id}
              disabled={member.revoked || saving !== null}
              onClick={() => void setMode(item.id)}
              data-testid={`assistant-mode-${item.id}`}
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-default",
                mode === item.id
                  ? "border-primary/60 bg-primary/5"
                  : "border-border hover:bg-accent/50",
              )}
            >
              <item.Icon
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  item.id === "itself" ? "text-amber-500" : "text-amber-600",
                )}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {saving === item.id ? "Switching…" : item.name}
                </span>
                <span className="block text-xs text-muted-foreground">{item.line}</span>
              </span>
            </button>
          ))}
        </div>
        {busy ? (
          <p className="text-xs text-muted-foreground" data-testid="assistant-mode-busy-note">
            It's working on {task} now — a change applies from its next step.
          </p>
        ) : null}
      </div>
      {member.isUno ? (
        <div className="px-4 py-2.5 text-xs text-muted-foreground">
          Uno comes with {props.machineLabel} and can't be removed.
        </div>
      ) : member.revoked ? null : (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-xs">
          {confirm ? (
            <>
              <span className="text-foreground" data-testid="assistant-remove-question">
                {busy
                  ? `${name} is working on ${task}. Remove it and stop that?`
                  : `Remove ${full}? Its chats stay.`}
              </span>
              <Button
                size="xs"
                variant="destructive"
                onClick={() => void remove()}
                data-testid="assistant-remove-confirm"
              >
                {busy ? "Stop and remove" : "Remove"}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setConfirm(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirm(true)}
              className="inline-flex cursor-pointer items-center gap-1 text-destructive hover:underline"
              data-testid="assistant-remove"
            >
              <UserRoundXIcon className="size-3.5" /> Remove {name}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
