/**
 * "Settings" at the top of every assistant's chat (Misha 29.10: "I couldn't go
 * back and change an assistant's settings"). One labelled button, the same in
 * Uno's chat and a helper's: it opens the assistant's page, where its name,
 * face, permission level, computer, apps, AI, Telegram and instructions are.
 * A phone shows the gear alone (the label is its hover text and its name).
 */
import { useNavigate } from "@tanstack/react-router";
import { Settings2Icon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { assistantSettingsSearch } from "./assistantSettingsNav.logic";
import type { TeamMember } from "./useAssistantTeam";

export function AssistantSettingsButton(props: {
  readonly member: Pick<TeamMember, "environmentId" | "projectId" | "profile">;
  /** Gear only (a phone, a narrow header). */
  readonly compact?: boolean;
}) {
  const navigate = useNavigate();
  const name = props.member.profile.name;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${name}'s settings`}
            onClick={() =>
              void navigate({ to: "/assistants", search: assistantSettingsSearch(props.member) })
            }
            data-testid="assistant-header-settings"
            className={cn(
              "inline-flex h-7 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-input text-xs font-medium text-foreground shadow-xs/5 hover:bg-accent sm:h-6",
              props.compact ? "min-w-7 sm:min-w-6" : "px-2",
            )}
          />
        }
      >
        <Settings2Icon className="size-3.5" />
        {props.compact ? null : <span>Settings</span>}
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-72">
        {name}'s settings: name and face, permission level, computer, apps, AI, Telegram,
        instructions
      </TooltipPopup>
    </Tooltip>
  );
}
