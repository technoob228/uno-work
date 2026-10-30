/**
 * `/assistants` with the assistants update (29.10): every assistant the
 * sidebar shows — Uno first, then the helpers — each row opening its page
 * (`view=profile`), the one place with all of its settings. Until 29.10 this
 * address showed the 0.0.106 list, whose rows opened two older pages (Uno's
 * 0.0.105 card with "Delete", a helper's page that only said "Open its page").
 */
import { useNavigate } from "@tanstack/react-router";
import { BotIcon, ChevronRightIcon, PlusIcon } from "lucide-react";

import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { AssistantAvatar, avatarImageOf } from "./AssistantAvatar";
import { ACTIVITY_LABEL } from "./assistantTeam.logic";
import { assistantSettingsSearch, settingsListOrder } from "./assistantSettingsNav.logic";
import { MODE_COPY, modeOf } from "./PersonaMode";
import { type TeamMember, useAssistantTeam } from "./useAssistantTeam";

function TeamRow(props: { readonly member: TeamMember; readonly onOpen: () => void }) {
  const { member } = props;
  const { profile } = member;
  const telegram = member.summary?.telegram;
  const talk = telegram?.configured
    ? `Telegram${telegram.botUsername ? ` @${telegram.botUsername}` : ""}`
    : "Here in Uno Work";
  const line = member.revoked
    ? "Removed · its chats stay"
    : [
        member.isUno ? "Your main assistant" : (profile.roles[0] ?? "Helper"),
        MODE_COPY[modeOf(member)].label,
        `on ${member.computerLabel || "your cloud computer"}`,
        talk,
      ].join(" · ");
  return (
    <button
      type="button"
      onClick={props.onOpen}
      data-testid="assistants-team-row"
      data-assistant={member.projectId}
      className="flex w-full cursor-pointer items-center gap-3 rounded-xl border border-border bg-card/40 px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
    >
      <AssistantAvatar
        emoji={profile.emoji}
        image={avatarImageOf(profile)}
        tone={profile.tone}
        activity={member.revoked ? null : member.activity}
        revoked={member.revoked}
        className="size-10 shrink-0"
        emojiClassName="text-xl"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{profile.name}</span>
          {member.revoked ? null : (
            <span className="shrink-0 text-xs font-normal text-muted-foreground">
              {ACTIVITY_LABEL[member.activity]}
            </span>
          )}
        </span>
        <span className="truncate text-xs text-muted-foreground">{line}</span>
      </span>
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">Settings</span>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

export function AssistantsTeamList() {
  const navigate = useNavigate();
  const team = useAssistantTeam();
  const { live, removed } = settingsListOrder(team);
  const open = (member: TeamMember) =>
    void navigate({ to: "/assistants", search: assistantSettingsSearch(member) });
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden"
        data-testid="assistants-team-list"
      >
        <header className="flex min-h-12 items-center gap-2 border-b border-border px-3 sm:px-5">
          <SidebarShowButton />
          <BotIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Assistants</span>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-5">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-0 flex-1">
                <h1 className="text-xl font-semibold tracking-tight">Assistants</h1>
                <p className="text-sm text-muted-foreground">
                  Open one to change its name and face, permission level, computer, apps, AI,
                  Telegram and instructions.
                </p>
              </div>
              <Button
                onClick={() => void navigate({ to: "/assistants", search: { view: "new" } })}
                data-testid="assistants-new"
              >
                <PlusIcon className="size-4" />
                New assistant
              </Button>
            </div>
            <div className="flex flex-col gap-2" data-testid="assistants-list">
              {live.map((member) => (
                <TeamRow key={member.key} member={member} onOpen={() => open(member)} />
              ))}
              {live.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Loading your assistants… (a computer that is asleep shows its assistants when it
                  wakes up)
                </p>
              ) : null}
            </div>
            {removed.length > 0 ? (
              <div className="flex flex-col gap-2" data-testid="assistants-removed">
                <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Removed
                </h2>
                {removed.map((member) => (
                  <TeamRow key={member.key} member={member} onOpen={() => open(member)} />
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
