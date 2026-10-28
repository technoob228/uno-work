/**
 * Variant B (28.10) — the small pieces that name an assistant by its
 * computer: the computer tag in a row, the line under its name in a chat,
 * the sheet of a sleeping one, the Free banner in its chat and its rows in
 * the computer switcher (layout B2). Data: `perMachine.ts`.
 */
import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";
import { MoonIcon, ZapIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { CHOOSE_PLAN_URL } from "../../account/planStatus";
import { useMachineRows } from "../../hooks/useMachineRows";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { AssistantAvatar, avatarImageOf } from "./AssistantAvatar";
import { ACTIVITY_LABEL } from "./assistantTeam.logic";
import {
  type MachineAssistant,
  assistantFullName,
  useAccountPlan,
  useAssistantOfThread,
  useAssistantsByMachine,
  useAsleepSheet,
  useOpenMachineAssistant,
} from "./perMachine";
import type { TeamMember } from "./useAssistantTeam";

/** The computer an assistant lives on, as a small tag next to its name. */
export function MachineTag(props: {
  readonly label: string;
  readonly asleep?: boolean;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-24 shrink-0 items-center gap-0.5 truncate rounded-md px-1.5 py-px text-[10px] leading-4 font-medium",
        props.asleep
          ? "bg-muted text-muted-foreground"
          : "bg-primary/8 text-primary dark:bg-primary/15",
        props.className,
      )}
      data-testid="assistant-machine-tag"
      title={props.asleep ? `${props.label} is asleep` : `Lives on ${props.label}`}
    >
      {props.asleep ? <MoonIcon className="size-2.5 shrink-0" aria-hidden /> : null}
      <span className="truncate">{props.label}</span>
    </span>
  );
}

/** Is this computer a Free cloud one (it sleeps when nobody uses it)? */
function useSleepsOnFree(environmentId: string | null, boxId: number | null): boolean {
  const plan = useAccountPlan();
  const rows = useMachineRows();
  const row = rows.find(
    (item) =>
      (environmentId !== null && item.environmentId === environmentId) ||
      (boxId !== null && item.box?.id === boxId),
  );
  if (!row || row.kind !== "uno_box") return false;
  // The page's own computer goes by the account's plan; another box by its own.
  const boxPlan = (row.box as { plan?: string } | null)?.plan;
  // (The switcher's list of boxes doesn't carry each box's plan yet: a box
  // that sleeps on its own is taken for a Free one — new for the console.)
  if (boxPlan !== undefined) return boxPlan === "free";
  if (row.isPrimary) return plan === "free";
  return row.box?.status === "sleeping";
}

/**
 * The sheet of a sleeping assistant: why it sleeps (its computer does) and
 * the honest way out — wake it now, or keep it on with Plus.
 */
export function AsleepAssistantSheet() {
  const assistant = useAsleepSheet((state) => state.open);
  const show = useAsleepSheet((state) => state.show);
  const free = useSleepsOnFree(
    assistant?.machine.environmentId ?? null,
    assistant?.machine.boxId ?? null,
  );
  if (assistant === null) return null;
  const full = assistantFullName(assistant.name, assistant.machine.label);
  const laptop = assistant.machine.kind === "computer";
  const close = () => show(null);
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
      <DialogPopup className="max-w-[26rem]" data-testid="assistant-asleep-sheet">
        <div className="flex flex-col gap-3 p-5">
          <div className="flex items-center gap-3">
            <AssistantAvatar
              emoji={assistant.isUno ? null : assistant.emoji}
              tone={assistant.tone}
              className="size-10 opacity-70 grayscale"
              emojiClassName="text-xl"
            />
            <DialogTitle className="text-base">{full} is asleep</DialogTitle>
          </div>
          {laptop ? (
            <p className="text-sm text-muted-foreground">
              It lives on {assistant.machine.label} and sleeps while the laptop is closed. Tasks you
              give it wait in Needs you and start when the laptop opens.
            </p>
          ) : free ? (
            <p className="text-sm text-muted-foreground">
              {assistant.machine.label} is on Free: it sleeps when nobody uses it, and{" "}
              {assistant.name} sleeps with it. No morning summary, no Telegram replies until it
              wakes — waking takes about 20 s.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {assistant.machine.label} is asleep. {assistant.name} answers once it wakes — about 20
              s.
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {free && !laptop ? (
              <Button
                size="sm"
                onClick={() => window.open(CHOOSE_PLAN_URL, "_blank", "noopener")}
                data-testid="assistant-asleep-plus"
              >
                <ZapIcon className="size-3.5" /> Keep it on with Plus
              </Button>
            ) : null}
            {!laptop ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  close();
                  toastManager.add({
                    type: "info",
                    title: `Waking ${assistant.machine.label}`,
                    description: `About 20 s. ${assistant.name} answers when it's up.`,
                  });
                }}
                data-testid="assistant-asleep-wake"
              >
                Wake {assistant.machine.label}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={close}>
                OK
              </Button>
            )}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

/** The left of an assistant chat's header: its face, "Uno · MacBook", what it sees. */
export function MachineAssistantHeadline(props: {
  readonly member: TeamMember;
  readonly machineLabel: string;
}) {
  const { member } = props;
  const navigate = useNavigate();
  const telegram = member.summary?.telegram.configured === true;
  return (
    <button
      type="button"
      onClick={() =>
        void navigate({
          to: "/assistants",
          search: { view: "profile", env: member.environmentId, project: member.projectId },
        })
      }
      title={`${assistantFullName(member.profile.name, props.machineLabel)} — open its page`}
      className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-md text-left hover:opacity-80"
      data-testid="machine-assistant-headline"
    >
      <AssistantAvatar
        emoji={member.profile.emoji}
        image={avatarImageOf(member.profile)}
        tone={member.profile.tone}
        activity={member.activity}
        className="size-7 shrink-0"
        emojiClassName="text-sm"
      />
      <span className="min-w-0 leading-tight">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-foreground">
          <span className="min-w-0 truncate">{member.profile.name}</span>
          <MachineTag label={props.machineLabel} />
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {ACTIVITY_LABEL[member.activity]} · sees only {props.machineLabel}
          {telegram ? " · in Telegram" : ""}
        </span>
      </span>
    </button>
  );
}

/**
 * In an assistant's chat on a Free cloud computer: it sleeps with its
 * computer — said once, with the way to keep it on.
 */
export function AssistantPlanBanner(props: {
  readonly environmentId: string;
  readonly threadId: string;
}) {
  const of = useAssistantOfThread(props.environmentId, props.threadId);
  const free = useSleepsOnFree(props.environmentId, null);
  if (of === null || !free) return null;
  return (
    <div
      className="mx-auto mt-2 flex w-full max-w-3xl items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-foreground"
      data-testid="assistant-free-banner"
    >
      <MoonIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600" aria-hidden />
      <span className="min-w-0 flex-1">
        <b className="font-medium">
          On Free, {of.machineLabel} sleeps 15 min after you leave — {of.member.profile.name} sleeps
          with it.
        </b>{" "}
        <span className="text-muted-foreground">
          No morning summary; Telegram replies wait about 20 s for it to wake.
        </span>
      </span>
      <button
        type="button"
        onClick={() => window.open(CHOOSE_PLAN_URL, "_blank", "noopener")}
        className="shrink-0 cursor-pointer font-medium text-primary hover:underline"
        data-testid="assistant-free-banner-plus"
      >
        Keep it on — Plus
      </button>
    </div>
  );
}

/** Layout B2: a computer's assistants at the top of its row in the computer switcher. */
export function SwitcherAssistants(props: {
  readonly environmentId: string | null;
  readonly boxId: number | null;
  readonly onOpened?: () => void;
}) {
  const groups = useAssistantsByMachine();
  const open = useOpenMachineAssistant();
  const group = groups.find(
    (item) =>
      (props.environmentId !== null && item.environmentId === props.environmentId) ||
      (props.boxId !== null && item.boxId === props.boxId),
  );
  if (!group) return null;
  return (
    <ul className="flex flex-col pb-0.5 pl-5" data-testid="switcher-assistants">
      {group.assistants.map((assistant: MachineAssistant) => (
        <li key={assistant.key} className="list-none">
          <button
            type="button"
            onClick={() => {
              props.onOpened?.();
              void open(assistant);
            }}
            className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-accent"
            data-testid="switcher-assistant"
            data-assistant={assistant.projectId}
          >
            <AssistantAvatar
              emoji={assistant.isUno ? null : assistant.emoji}
              image={assistant.member ? avatarImageOf(assistant.member.profile) : null}
              tone={assistant.tone}
              activity={assistant.activity}
              className={cn("size-5 shrink-0", !assistant.awake && "opacity-60 grayscale")}
              emojiClassName="text-[11px]"
            />
            <span className="min-w-0 flex-1 truncate font-medium">
              {assistant.name}
              <span className="font-normal text-muted-foreground"> · {group.label}</span>
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {assistant.awake
                ? assistant.projectId === ASSISTANT_PROJECT_ID
                  ? "its assistant"
                  : "assistant"
                : "asleep"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
