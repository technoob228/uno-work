/**
 * Variant C: an assistant's mode, in the header of its chat and on its page —
 * exactly two (Misha 27.10): "Does it itself" (acts, tells you after) and
 * "Asks first" (waits for your OK before it sends, pays or deletes). Uno and
 * each teammate have their own; a change applies to the next action, also in
 * a task that is already running.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, HandIcon, ZapIcon } from "lucide-react";
import { useState } from "react";

import { setAssistantPreset } from "../../../lib/managerApi";
import { cn } from "../../../lib/utils";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { toastManager } from "../../ui/toast";
import type { TeamMember } from "../useAssistantTeam";
import { useTeamActions } from "../useTeamActions";

export type TwoModes = "itself" | "asks-first";

export const MODE_COPY: Record<TwoModes, { label: string; line: string }> = {
  itself: { label: "Does it itself", line: "Acts, then tells you what it did." },
  "asks-first": {
    label: "Asks first",
    line: "Waits for your OK before it sends, pays or deletes.",
  },
};

export function modeOf(member: TeamMember): TwoModes {
  return member.profile.preset === "full" ? "itself" : "asks-first";
}

export function useSetMode(member: TeamMember) {
  const actions = useTeamActions();
  const [pending, setPending] = useState<TwoModes | null>(null);
  const set = async (mode: TwoModes) => {
    if (mode === modeOf(member)) return;
    setPending(mode);
    try {
      await setAssistantPreset({
        environmentId: member.environmentId as EnvironmentId,
        projectId: member.projectId,
        preset: mode === "itself" ? "full" : "helper",
        projects: member.profile.projects,
      });
      await actions.refresh();
      toastManager.add({
        type: "success",
        title: `${member.profile.name}: ${MODE_COPY[mode].label}`,
        description: "From its next action — also in a task that's running.",
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't change the mode",
        description: cause instanceof Error ? cause.message : "Its computer didn't answer.",
      });
    } finally {
      setPending(null);
    }
  };
  return { mode: pending ?? modeOf(member), set, pending: pending !== null };
}

export function ModeChip(props: { readonly member: TeamMember; readonly className?: string }) {
  const { mode, set, pending } = useSetMode(props.member);
  const Icon = mode === "itself" ? ZapIcon : HandIcon;
  return (
    <Menu>
      <MenuTrigger
        data-testid="assistant-mode-chip"
        data-mode={mode}
        disabled={pending}
        className={cn(
          "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs font-medium shadow-xs/5 sm:h-6",
          mode === "asks-first"
            ? "border-amber-500/40 bg-amber-500/8 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
            : "border-input text-foreground hover:bg-accent",
          props.className,
        )}
      >
        <Icon className="size-3.5" />
        {MODE_COPY[mode].label}
        <ChevronDownIcon className="size-3 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="min-w-64">
        {(["itself", "asks-first"] as const).map((item) => (
          <MenuItem
            key={item}
            onClick={() => void set(item)}
            data-testid={`assistant-mode-${item}`}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm">{MODE_COPY[item].label}</span>
              <span className="text-[11px] text-muted-foreground">{MODE_COPY[item].line}</span>
            </span>
            {item === mode ? <CheckIcon className="size-3.5 text-primary" /> : null}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
