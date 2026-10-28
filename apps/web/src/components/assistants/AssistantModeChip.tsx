/**
 * The two modes, one click away at the top of an assistant's chat (Misha
 * 27.10: keep exactly two — "Does it itself" / "Asks first"). Changing it
 * mid-task applies from its next step: what it was about to send, pay,
 * publish or delete then waits for an Allow. The daemon rewrites its token
 * (`/api/manager/assistant/preset`), the chats switch with it.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, HandIcon, ZapIcon } from "lucide-react";
import { useState } from "react";

import { setAssistantPreset } from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import type { TeamMember } from "./useAssistantTeam";
import { useTeamActions } from "./useTeamActions";

export type AssistantMode = "itself" | "asks-first";

export const MODE_COPY: Record<AssistantMode, { readonly label: string; readonly detail: string }> =
  {
    itself: {
      label: "Does it itself",
      detail: "Acts right away and tells you after.",
    },
    "asks-first": {
      label: "Asks first",
      detail: "Shows what it's about to send, pay, publish or delete, and waits for your Allow.",
    },
  };

export function modeOf(member: Pick<TeamMember, "profile">): AssistantMode {
  return member.profile.preset === "full" ? "itself" : "asks-first";
}

/** Sets the mode on its computer; the page reads it back. */
export function useSetAssistantMode() {
  const actions = useTeamActions();
  const [busy, setBusy] = useState(false);
  const set = async (member: TeamMember, mode: AssistantMode) => {
    setBusy(true);
    try {
      await setAssistantPreset({
        environmentId: member.environmentId as EnvironmentId,
        projectId: member.projectId,
        preset: mode === "itself" ? "full" : "helper",
        projects: "all",
      });
      await actions.refresh();
      toastManager.add({
        type: "success",
        title: `${member.profile.name}: ${MODE_COPY[mode].label}`,
        description: "From its next step.",
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't change the mode",
        description: cause instanceof Error ? cause.message : "Its computer didn't answer.",
      });
    } finally {
      setBusy(false);
    }
  };
  return { set, busy };
}

export function ModeIcon(props: { readonly mode: AssistantMode; readonly className?: string }) {
  return props.mode === "itself" ? (
    <ZapIcon className={cn("text-sky-500", props.className)} />
  ) : (
    <HandIcon className={cn("text-amber-500", props.className)} />
  );
}

export function AssistantModeChip(props: { readonly member: TeamMember }) {
  const { member } = props;
  const mode = modeOf(member);
  const { set, busy } = useSetAssistantMode();
  return (
    <Menu>
      <MenuTrigger
        data-testid="assistant-mode-chip"
        data-mode={mode}
        disabled={busy || member.revoked}
        className={cn(
          "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium shadow-xs/5 sm:h-6",
          mode === "itself"
            ? "border-sky-500/30 bg-sky-500/5 text-foreground hover:bg-sky-500/10"
            : "border-amber-500/40 bg-amber-500/10 text-foreground hover:bg-amber-500/15",
        )}
      >
        <ModeIcon mode={mode} className="size-3.5" />
        {MODE_COPY[mode].label}
        <ChevronDownIcon className="size-3 text-muted-foreground" />
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="w-72">
        {(["itself", "asks-first"] as const).map((item) => (
          <MenuItem
            key={item}
            onClick={() => {
              if (item !== mode) void set(member, item);
            }}
            data-testid={`assistant-mode-${item}`}
            className="items-start gap-2 py-2"
          >
            <ModeIcon mode={item} className="mt-0.5 size-4 shrink-0" />
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">
                {MODE_COPY[item].label}
                {item === mode ? <span className="ml-1.5 text-xs text-primary">· now</span> : null}
              </span>
              <span className="text-xs whitespace-normal text-muted-foreground">
                {MODE_COPY[item].detail}
              </span>
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
