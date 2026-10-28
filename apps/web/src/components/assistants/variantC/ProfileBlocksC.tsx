/**
 * Variant C on an assistant's page (the real AssistantProfileSimple):
 *
 * - the mode as two cards, at the top — not under Advanced (Misha 27.10:
 *   exactly two modes);
 * - Uno's page: where Uno works (every computer, nothing to set up there)
 *   and the team under Uno;
 * - a teammate's page: it reports to Uno and talks to you through Uno;
 *   "Remove from team" — mid-task Uno takes the task over.
 */
import type { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { HandIcon, PlusIcon, UserRoundXIcon, ZapIcon } from "lucide-react";
import { useState } from "react";

import { useAssistantChat } from "../../../assistant/useAssistantChat";
import { cn } from "../../../lib/utils";
import { buildThreadRouteParams } from "../../../threadRoutes";
import { resolveSidebarThreadStatus } from "../../Sidebar.logic";
import { MACHINE_KIND_ICON } from "../../machineKindIcons";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { AssistantAvatar, avatarImageOf } from "../AssistantAvatar";
import { Section } from "../AssistantProfileParts";
import { ACTIVITY_LABEL } from "../assistantTeam.logic";
import { type TeamMember, useAssistantTeam } from "../useAssistantTeam";
import { useTeamActions } from "../useTeamActions";
import { MODE_COPY, type TwoModes, modeOf, useSetMode } from "./ModeChip";
import { handAwake, handLine, useUnoHands } from "./useUnoHands";
import { PLUS_URL, useUnoPlan } from "./useUnoPlan";

/** The two modes as cards: one click switches. */
export function ModeCards(props: { readonly member: TeamMember }) {
  const { mode, set, pending } = useSetMode(props.member);
  const card = (item: TwoModes) => {
    const Icon = item === "itself" ? ZapIcon : HandIcon;
    const active = mode === item;
    return (
      <button
        key={item}
        type="button"
        disabled={pending || props.member.revoked}
        onClick={() => void set(item)}
        aria-pressed={active}
        data-testid={`assistant-mode-card-${item}`}
        className={cn(
          "flex flex-1 cursor-pointer flex-col gap-1 rounded-xl border p-3 text-left transition-colors disabled:cursor-default",
          active
            ? item === "asks-first"
              ? "border-amber-500/50 bg-amber-500/8"
              : "border-primary/50 bg-primary/[0.05]"
            : "border-border hover:bg-accent/50",
        )}
      >
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <Icon
            className={cn("size-4", item === "asks-first" ? "text-amber-600" : "text-primary")}
          />
          {MODE_COPY[item].label}
        </span>
        <span className="text-xs text-muted-foreground">{MODE_COPY[item].line}</span>
      </button>
    );
  };
  return (
    <Section title="How it works" testId="assistant-mode-cards">
      <div className="flex flex-col gap-2 sm:flex-row">
        {card("itself")}
        {card("asks-first")}
      </div>
    </Section>
  );
}

/** Uno's page: every computer of the account — Uno uses each, nothing to set up there. */
export function UnoWorksOn() {
  const hands = useUnoHands();
  const plan = useUnoPlan();
  const navigate = useNavigate();
  return (
    <Section title="Works on your computers" testId="uno-works-on">
      <div className="rounded-lg border border-border bg-card/40">
        {hands.map((hand, index) => {
          const Icon = MACHINE_KIND_ICON[hand.kind];
          const latest = [...hand.waiting, ...hand.running][0];
          return (
            <div
              key={hand.key}
              className={cn(
                "flex items-center gap-2.5 px-3 py-2 text-sm",
                index > 0 && "border-t border-border/70",
              )}
              data-testid="uno-works-on-row"
            >
              <Icon
                className={cn(
                  "size-4",
                  handAwake(hand) ? "text-foreground/70" : "text-muted-foreground/40",
                )}
              />
              <span className="min-w-0 flex-1 truncate">
                {hand.label}
                {hand.isPrimary ? (
                  <span className="text-xs text-muted-foreground"> · Uno lives here</span>
                ) : null}
              </span>
              <span
                className={cn(
                  "shrink-0 text-xs",
                  hand.waiting.length > 0 ? "text-warning" : "text-muted-foreground",
                )}
              >
                {handLine(hand)}
              </span>
              {latest ? (
                <button
                  type="button"
                  className="shrink-0 cursor-pointer text-xs text-primary hover:underline"
                  onClick={() =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams({
                        environmentId: latest.environmentId,
                        threadId: latest.id as ThreadId,
                      }),
                    })
                  }
                >
                  Open
                </button>
              ) : null}
            </div>
          );
        })}
        <p className="border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
          Uno runs tasks on any of them — no setup on each. An asleep one waits; Uno asks where else
          to do it.
          {plan === "free" ? (
            <>
              {" "}
              On Free your cloud computer sleeps too —{" "}
              <a
                href={PLUS_URL}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                Plus keeps it on
              </a>
              .
            </>
          ) : null}
        </p>
      </div>
    </Section>
  );
}

/** Uno's page: the team under Uno — it hands them tasks, their reports come through it. */
export function TeamUnderUno() {
  const team = useAssistantTeam().filter((member) => !member.isUno && !member.revoked);
  const navigate = useNavigate();
  const open = (member: TeamMember) =>
    void navigate({
      to: "/assistants",
      search: { view: "profile", env: member.environmentId, project: member.projectId },
    });
  return (
    <Section
      title={`Your team · ${team.length}`}
      testId="uno-team"
      action={
        <button
          type="button"
          onClick={() => void navigate({ to: "/assistants", search: { view: "new" } })}
          className="inline-flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline"
          data-testid="uno-team-new"
        >
          <PlusIcon className="size-3" /> New teammate
        </button>
      }
    >
      <div className="rounded-lg border border-border bg-card/40">
        {team.length === 0 ? (
          <p className="px-3 py-2.5 text-sm text-muted-foreground">
            No teammates yet. Add a secretary or a marketer — Uno gives them tasks and tells you
            what they did.
          </p>
        ) : (
          team.map((member, index) => (
            <button
              key={member.key}
              type="button"
              onClick={() => open(member)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-accent/40",
                index > 0 && "border-t border-border/70",
              )}
            >
              <AssistantAvatar
                emoji={member.profile.emoji}
                image={avatarImageOf(member.profile)}
                tone={member.profile.tone}
                activity={member.activity}
                className="size-6"
                emojiClassName="text-xs"
              />
              <span className="w-28 shrink-0 truncate font-medium">{member.profile.name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {[
                  member.profile.roles[0],
                  MODE_COPY[modeOf(member)].label,
                  ACTIVITY_LABEL[member.activity],
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
          ))
        )}
      </div>
    </Section>
  );
}

/** A teammate's page: how you reach it (through Uno — one Telegram, one Inbox). */
export function ThroughUno(props: { readonly member: TeamMember }) {
  return (
    <div
      className="flex items-start gap-3 rounded-xl border border-border bg-card/40 px-4 py-3"
      data-testid="teammate-through-uno"
    >
      <AssistantAvatar emoji={null} tone="violet" className="size-7 shrink-0" />
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">
          {props.member.profile.name} reports to Uno.
        </span>{" "}
        Give it tasks here, or tell Uno. Its questions and reports reach you through Uno: Uno's
        chat, your Inbox, Uno's Telegram. Nothing to connect.
      </p>
    </div>
  );
}

/** "Remove from team": mid-task, Uno takes the task over and finishes it. */
export function RemoveFromTeam(props: { readonly member: TeamMember }) {
  const { member } = props;
  const actions = useTeamActions();
  const unoChat = useAssistantChat();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = member.profile.name;
  const running = [...member.chats.work, ...member.chats.conversations].filter((thread) => {
    const status = resolveSidebarThreadStatus(thread);
    return status === "working" || status === "approval" || status === "input";
  });
  const remove = async () => {
    setBusy(true);
    try {
      await actions.revoke(member);
      toastManager.add({
        type: "success",
        title: `${name} is off the team`,
        description:
          running.length > 0
            ? "Uno took over what it was doing. Its chats stay."
            : "Its chats stay. Bring it back any time.",
      });
      if (running.length > 0) void unoChat.open();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: `Couldn't remove ${name}`,
        description: cause instanceof Error ? cause.message : "Its computer didn't answer.",
      });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  if (member.isUno || member.revoked) return null;
  return (
    <div className="flex flex-col gap-2 px-1" data-testid="teammate-remove">
      {confirming ? (
        <div className="flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.04] p-3">
          <p className="text-sm">
            {running.length > 0 ? (
              <>
                <span className="font-medium">
                  {name} is in the middle of “{running[0]!.title}”.
                </span>{" "}
                Remove it anyway? Uno takes the task over and finishes it.
              </>
            ) : (
              <>Remove {name} from your team? Its chats stay; you can bring it back.</>
            )}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void remove()}
              data-testid="teammate-remove-confirm"
            >
              {running.length > 0 ? "Remove — Uno takes over" : "Remove"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="inline-flex w-fit cursor-pointer items-center gap-1 text-xs text-destructive hover:underline"
          data-testid="teammate-remove-start"
        >
          <UserRoundXIcon className="size-3.5" />
          Remove from team
        </button>
      )}
    </div>
  );
}
