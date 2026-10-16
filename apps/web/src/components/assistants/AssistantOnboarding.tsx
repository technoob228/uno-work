/**
 * Setting up an assistant (Misha 14.10, strategy/ASSISTANT_SETUP_FLOW.md):
 * the first click on Uno, or "New assistant" in the sidebar.
 *
 *   0. Meet it: what an assistant is — [Set up in a minute] [Later].
 *   1. Where you talk to it: Uno's assistant bot by a one-tap link (default,
 *      decision 14.10), your own Telegram bot, or Slack.
 *   2. What it can open: projects (all by default) and computers (this one).
 *   3. What it may do: Full (default, decision 14.10) / Helper / Observer.
 *   4. What it runs on: any AI on the computer (`AssistantPowerPicker`).
 *   5. Who it is: name, role, character, skills, face.
 *   6. Ready: "Write the first task" — here or in the channel picked.
 *
 * Every step comes filled in: "Next" all the way is a working assistant.
 * It takes tasks only from the person — never a public bot.
 */
import { type EnvironmentId, type ProjectId, isAssistantProjectId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime";
import { useRouter } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChevronRightIcon,
  CheckIcon,
  CopyIcon,
  DicesIcon,
  ExternalLinkIcon,
  EyeIcon,
  HandIcon,
  LaptopIcon,
  MessageCircleIcon,
  SendIcon,
  ShieldCheckIcon,
  SlackIcon,
  ZapIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useActiveMachine } from "../../hooks/useActiveMachine";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useMachineRows } from "../../hooks/useMachineRows";
import { createAssistant, startTelegramPairing } from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { AssistantPowerPicker } from "../assistant/AssistantPowerPicker";
import { openInstallDocs } from "../onboarding/harnessInstallLinks";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Toggle } from "../ui/toggle";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { AssistantAvatar } from "./AssistantAvatar";
import { TeammateAccess } from "./TeammateAccess";
import {
  type AssistantDraft,
  type AssistantPreset,
  brainLine,
  CHANNEL_NAME,
  CHARACTER_CHIPS,
  PRESETS,
  PRESET_NAME,
  ROLE_CHIPS,
  assistantKeyOf,
  defaultDraft,
  nextAvatar,
  ownComputerName,
  projectsLine,
  roleSkills,
  toggleRole,
  uniqueName,
} from "./assistantTeam.logic";
import { useAssistantTeamStore } from "./assistantTeamStore";
import { type TeamMember, useAssistantTeam } from "./useAssistantTeam";

/** Uno's second bot — for assistants (the first one carries notifications). */
export const UNO_ASSISTANT_BOT = "uno_team_bot";

const STEP_COUNT = 6;

/** Where a limited assistant lives: the picked computer, or the new one. */
const ownLabel = (draft: AssistantDraft) =>
  draft.ownComputer ?? ownComputerName(draft.name.trim() || "assistant");

// ── Who opens it, and where it is ─────────────────────────────────────────

type Target =
  | { readonly kind: "new" }
  | {
      readonly kind: "existing";
      readonly environmentId: string;
      readonly projectId: string;
      readonly name: string;
    };

interface Ready {
  readonly environmentId: string;
  readonly projectId: string;
  readonly link: string | null;
}

interface OnboardingState {
  readonly open: boolean;
  readonly step: number;
  readonly target: Target;
  readonly draft: AssistantDraft | null;
  readonly ready: Ready | null;
  readonly openNew: (step?: number) => void;
  readonly openFor: (member: Pick<TeamMember, "environmentId" | "projectId" | "profile">) => void;
  readonly setStep: (step: number) => void;
  readonly patch: (patch: Partial<AssistantDraft>) => void;
  readonly setDraft: (draft: AssistantDraft) => void;
  readonly setReady: (ready: Ready) => void;
  readonly close: () => void;
}

export const useAssistantOnboarding = create<OnboardingState>((set, get) => ({
  open: false,
  step: 0,
  target: { kind: "new" },
  draft: null,
  ready: null,
  openNew: (step = 0) =>
    set({ open: true, step, target: { kind: "new" }, draft: null, ready: null }),
  openFor: (member) =>
    set({
      open: true,
      step: 0,
      target: {
        kind: "existing",
        environmentId: member.environmentId,
        projectId: member.projectId,
        name: member.profile.name,
      },
      draft: null,
      ready: null,
    }),
  setStep: (step) => set({ step: Math.max(0, Math.min(STEP_COUNT, step)) }),
  patch: (patch) => {
    const draft = get().draft;
    if (draft) set({ draft: { ...draft, ...patch } });
  },
  setDraft: (draft) => set({ draft }),
  setReady: (ready) => set({ ready, step: STEP_COUNT }),
  close: () => set({ open: false }),
}));

// ── Small pieces ──────────────────────────────────────────────────────────

function Choice(props: {
  readonly selected: boolean;
  readonly onPick: () => void;
  readonly icon: ReactNode;
  readonly title: string;
  readonly badge?: string | undefined;
  readonly line: string;
  /** A second, lighter line: an example of what it means. */
  readonly example?: string | undefined;
  readonly children?: ReactNode;
  readonly testId?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border transition-colors",
        props.selected ? "border-primary bg-primary/5" : "border-border hover:bg-accent/40",
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={props.selected}
        onClick={props.onPick}
        data-testid={props.testId}
        className="flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2.5 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          aria-hidden
          className={cn(
            "mt-1.5 grid size-4 shrink-0 place-items-center rounded-full border",
            props.selected ? "border-primary bg-primary" : "border-input",
          )}
        >
          {props.selected ? <span className="size-1.5 rounded-full bg-primary-foreground" /> : null}
        </span>
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          {props.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            {props.title}
            {props.badge ? (
              <span className="rounded border border-border px-1 text-[10px] font-normal text-muted-foreground">
                {props.badge}
              </span>
            ) : null}
          </span>
          <span className="block text-xs leading-snug text-muted-foreground">{props.line}</span>
          {props.example ? (
            <span className="mt-0.5 block text-xs leading-snug text-muted-foreground/70 italic">
              {props.example}
            </span>
          ) : null}
        </span>
      </button>
      {props.selected && props.children ? (
        <div className="px-3 pb-3 pl-[4.5rem]">{props.children}</div>
      ) : null}
    </div>
  );
}

/** A chip on the shared toggle (critics D7: one look of a picked chip everywhere). */
function Chip(props: {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Toggle
      variant="outline"
      size="xs"
      pressed={props.on}
      onPressedChange={() => props.onClick()}
      className="rounded-full px-2.5 text-xs"
    >
      {props.children}
    </Toggle>
  );
}

function CheckRow(props: {
  readonly checked: boolean;
  readonly onToggle: () => void;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={props.onToggle}
      className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left text-sm hover:bg-accent/50 disabled:cursor-default disabled:opacity-50"
    >
      <span
        aria-hidden
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-[4px] border",
          props.checked ? "border-primary bg-primary text-primary-foreground" : "border-input",
        )}
      >
        {props.checked ? <CheckIcon className="size-3" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.detail ? (
        <span className="shrink-0 text-xs text-muted-foreground">{props.detail}</span>
      ) : null}
    </button>
  );
}

function StepHeading(props: { readonly title: string; readonly line?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <DialogTitle className="text-lg leading-tight">{props.title}</DialogTitle>
      {props.line ? <p className="text-sm text-muted-foreground">{props.line}</p> : null}
    </div>
  );
}

// ── Steps ─────────────────────────────────────────────────────────────────

function IntroStep(props: {
  readonly isUno: boolean;
  readonly name: string;
  readonly emoji: string | null;
  readonly tone: AssistantDraft["tone"];
}) {
  const lines: ReadonlyArray<{ icon: ReactNode; text: string }> = [
    {
      icon: <MessageCircleIcon className="size-4" />,
      text: "Runs your chats and starts work on your computers",
    },
    { icon: <HandIcon className="size-4" />, text: "Writes to you only when it needs you" },
    { icon: <SendIcon className="size-4" />, text: "Talk to it here, in Telegram or in Slack" },
    {
      icon: <ShieldCheckIcon className="size-4" />,
      text: "Takes tasks only from you — nobody else can use it",
    },
  ];
  return (
    <div className="flex flex-col items-center gap-4 pt-4 text-center">
      <AssistantAvatar
        emoji={props.isUno ? null : props.emoji}
        tone={props.tone}
        className="size-14"
        emojiClassName="text-3xl"
      />
      <div className="flex flex-col gap-1.5">
        <DialogTitle className="text-xl">
          {props.isUno ? "This is your assistant, Uno" : "A new teammate"}
        </DialogTitle>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          {props.isUno
            ? "It works for you like a teammate — on your computers, even when your laptop is closed."
            : `Give ${props.name || "it"} its own job, access and AI. It works next to Uno and answers only to you.`}
        </p>
      </div>
      <ul className="flex w-full max-w-sm flex-col gap-1.5 text-left">
        {lines.map((line) => (
          <li key={line.text} className="flex items-center gap-2.5 text-sm">
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
              {line.icon}
            </span>
            {line.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChannelStep(props: {
  readonly draft: AssistantDraft;
  readonly patch: OnboardingState["patch"];
}) {
  const [token, setToken] = useState("");
  const [otherWays, setOtherWays] = useState(props.draft.channel === "own-bot");
  const who = props.draft.name.trim() || "it";
  return (
    <div className="flex flex-col gap-4">
      <StepHeading
        title={`Where do you talk to ${who}?`}
        line={`You can always talk to ${who} here, too.`}
      />
      <div role="radiogroup" className="flex flex-col gap-2">
        <Choice
          selected={props.draft.channel === "uno-bot"}
          onPick={() => props.patch({ channel: "uno-bot" })}
          icon={<SendIcon className="size-4" />}
          title="Telegram, through Uno's bot"
          badge="Recommended"
          line="One tap: open the link, press Start. Nothing to paste."
          testId="assistant-setup-channel-uno-bot"
        >
          <code className="block truncate rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground">
            t.me/{UNO_ASSISTANT_BOT}?start=…
          </code>
          <p className="mt-1 text-[11px] text-muted-foreground">
            The link comes on the last step. Several assistants share the bot: switch with
            /assistant name.
          </p>
        </Choice>
        <Choice
          selected={props.draft.channel === "slack"}
          onPick={() => props.patch({ channel: "slack" })}
          icon={<SlackIcon className="size-4" />}
          title="Slack"
          line="Uno's Slack app. It writes under its own name, in the channels you pick."
          testId="assistant-setup-channel-slack"
        />
        {otherWays ? (
          <Choice
            selected={props.draft.channel === "own-bot"}
            onPick={() => props.patch({ channel: "own-bot" })}
            icon={<MessageCircleIcon className="size-4" />}
            title="Telegram, a bot of its own"
            line="Its own name in Telegram. Make a bot with @BotFather and paste its token."
            testId="assistant-setup-channel-own-bot"
          >
            <div className="flex items-center gap-2">
              <Input
                size="sm"
                placeholder="123456:ABC-…"
                value={token}
                onChange={(event) => setToken(event.currentTarget.value)}
                className="font-mono"
              />
              <Button
                size="xs"
                variant="outline"
                onClick={() => openInstallDocs("https://t.me/BotFather")}
              >
                @BotFather <ExternalLinkIcon className="size-3" />
              </Button>
            </div>
          </Choice>
        ) : (
          <button
            type="button"
            onClick={() => setOtherWays(true)}
            className="cursor-pointer self-start text-xs text-muted-foreground hover:text-foreground"
          >
            Other ways…
          </button>
        )}
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheckIcon className="size-3.5" /> It answers only you. Others who write to the bot
        get nothing.
      </p>
    </div>
  );
}

function AccessStep(props: {
  readonly draft: AssistantDraft;
  readonly patch: OnboardingState["patch"];
  readonly thisComputer: string | null;
  readonly isUno: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const machines = useMachineRows();
  const names = useMemo(
    () =>
      [
        ...new Set(
          projects
            .filter(
              (project) => !isAssistantProjectId(project.id) && project.name !== "Home folder",
            )
            .map((project) => project.name),
        ),
      ].toSorted((a, b) => a.localeCompare(b)),
    [projects],
  );
  const all = props.draft.projects === "all";
  const picked = new Set(all ? names : props.draft.projects);
  const toggleProject = (name: string) => {
    const next = new Set(picked);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    props.patch({ projects: [...next] });
  };
  const computers = machines.filter((machine) => machine.environmentId !== null);
  const toggleComputer = (id: string) => {
    const next = new Set(props.draft.computers);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    props.patch({ computers: [...next] });
  };
  return (
    <div className="flex flex-col gap-4">
      <StepHeading
        title={`What can ${props.draft.name.trim() || "it"} open?`}
        line="Everything else stays closed."
      />
      <section className="flex flex-col gap-1">
        <div className="flex items-center justify-between px-2">
          <span className="text-xs font-medium text-muted-foreground">Projects</span>
          <button
            type="button"
            onClick={() => props.patch({ projects: all ? [...names] : "all" })}
            className="cursor-pointer text-xs text-primary hover:underline"
          >
            {all ? "Pick some" : "All projects"}
          </button>
        </div>
        <CheckRow
          checked={all}
          onToggle={() => props.patch({ projects: all ? [] : "all" })}
          label="All projects"
          detail="new ones too"
        />
        {all ? null : (
          <div className="grid grid-cols-2 gap-x-2">
            {names.map((name) => (
              <CheckRow
                key={name}
                checked={picked.has(name)}
                onToggle={() => toggleProject(name)}
                label={name}
              />
            ))}
          </div>
        )}
      </section>
      {computers.length > 1 ? (
        <section className="flex flex-col gap-1">
          <span className="px-2 text-xs font-medium text-muted-foreground">
            Computers it can start chats on
          </span>
          {computers.map((machine) => (
            <CheckRow
              key={machine.key}
              checked={props.draft.computers.includes(machine.environmentId!)}
              onToggle={() => toggleComputer(machine.environmentId!)}
              label={machine.label}
              detail={
                machine.environmentId === props.thisComputer
                  ? "this computer"
                  : machine.status === "sleeping"
                    ? "asleep — wakes when needed"
                    : undefined
              }
            />
          ))}
        </section>
      ) : null}
      <section className="flex flex-col gap-1">
        {advanced || props.isUno ? (
          <>
            <span className="px-2 text-xs font-medium text-muted-foreground">
              {props.isUno ? "On this computer" : "Advanced · apps, browser, passwords, skills"}
            </span>
            <div className="rounded-lg border border-border">
              <TeammateAccess
                name={props.draft.name.trim() || "it"}
                access={props.draft.access}
                onChange={(access) => props.patch({ access })}
                foldWhenFull={props.isUno}
              />
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setAdvanced(true)}
            className="flex cursor-pointer items-center gap-1 self-start px-2 text-xs text-muted-foreground hover:text-foreground"
            data-testid="assistant-setup-advanced"
          >
            <ChevronRightIcon className="size-3" />
            Advanced: apps, browser, passwords, skills
          </button>
        )}
      </section>
    </div>
  );
}

const PRESET_ICON: Readonly<Record<AssistantPreset, ReactNode>> = {
  full: <ZapIcon className="size-4" />,
  helper: <HandIcon className="size-4" />,
  observer: <EyeIcon className="size-4" />,
};

/**
 * Decision 16.10 (Misha): limited rights hold only on a computer of its own —
 * on a shared one any assistant can read the others' files. Picking Observer
 * or Helper asks where it lives: a new Lite computer (default) or one you have.
 */
function OwnComputerPick(props: {
  readonly draft: AssistantDraft;
  readonly patch: OnboardingState["patch"];
  readonly homeEnvironmentId: string | null;
}) {
  const machines = useMachineRows();
  const team = useAssistantTeam();
  // "Its own" means nobody else lives there: not you, not another assistant.
  const taken = new Set(
    team.flatMap((member) => [member.environmentId, member.profile.ownComputer ?? ""]),
  );
  const others = machines.filter(
    (machine) =>
      machine.environmentId !== null &&
      machine.environmentId !== props.homeEnvironmentId &&
      !taken.has(machine.environmentId) &&
      !taken.has(machine.label),
  );
  const name = props.draft.name.trim() || "it";
  const fresh = ownComputerName(props.draft.name.trim() || "assistant");
  const ref = useRef<HTMLElement>(null);
  // It appears when Observer or Helper is picked — bring it into view.
  useEffect(() => ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), []);
  return (
    <section
      ref={ref}
      className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5"
      data-testid="assistant-setup-own-computer"
    >
      <span className="text-sm font-medium">Runs on its own computer</span>
      <span className="text-xs text-muted-foreground">
        Limits hold only there: next to you, {name} could still read every file on your computer.
      </span>
      <div role="radiogroup" className="mt-1 flex flex-col gap-0.5">
        {[
          { id: null, label: `A new Lite computer — ${fresh}`, detail: "made when you finish" },
          ...others.map((machine) => ({
            id: machine.label,
            label: machine.label,
            detail: machine.status === "sleeping" ? "asleep — wakes when needed" : undefined,
          })),
        ].map((option) => (
          <button
            key={option.id ?? "new"}
            type="button"
            role="radio"
            aria-checked={props.draft.ownComputer === option.id}
            onClick={() => props.patch({ ownComputer: option.id })}
            className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent/50"
          >
            <span
              aria-hidden
              className={cn(
                "grid size-3.5 shrink-0 place-items-center rounded-full border",
                props.draft.ownComputer === option.id ? "border-primary" : "border-input",
              )}
            >
              {props.draft.ownComputer === option.id ? (
                <span className="size-1.5 rounded-full bg-primary" />
              ) : null}
            </span>
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.detail ? (
              <span className="shrink-0 text-xs text-muted-foreground">{option.detail}</span>
            ) : null}
          </button>
        ))}
      </div>
      {others.length === 0 ? (
        <span className="px-1.5 text-xs text-muted-foreground">
          Your other computers already have you or an assistant on them.
        </span>
      ) : null}
    </section>
  );
}

function RightsStep(props: {
  readonly draft: AssistantDraft;
  readonly patch: OnboardingState["patch"];
  readonly isUno: boolean;
  readonly homeEnvironmentId: string | null;
}) {
  const [details, setDetails] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <StepHeading
        title={`What may ${props.draft.name.trim() || "it"} do?`}
        line="Change it any time on its page."
      />
      <div role="radiogroup" className="flex flex-col gap-2">
        {PRESETS.map((preset) => (
          <Choice
            key={preset.id}
            selected={props.draft.preset === preset.id}
            onPick={() => props.patch({ preset: preset.id })}
            icon={PRESET_ICON[preset.id]}
            title={preset.name}
            line={preset.line}
            example={`For example: ${preset.examples}`}
            testId={`assistant-setup-preset-${preset.id}`}
          />
        ))}
      </div>
      {props.isUno || props.draft.preset === "full" ? null : (
        <OwnComputerPick
          draft={props.draft}
          patch={props.patch}
          homeEnvironmentId={props.homeEnvironmentId}
        />
      )}
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => setDetails((value) => !value)}
          className="cursor-pointer self-start text-xs text-primary hover:underline"
        >
          {details ? "Hide limits" : "Limits"}
        </button>
        {details ? (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 rounded-lg border border-border px-3 py-2.5 text-xs">
            <dt className="text-muted-foreground">AI spending a day</dt>
            <dd>up to $5</dd>
            <dt className="text-muted-foreground">Turns a day</dt>
            <dd>up to 300</dd>
            <dt className="text-muted-foreground">Sets up other assistants</dt>
            <dd>only with less access than its own</dd>
          </dl>
        ) : null}
      </div>
    </div>
  );
}

function BrainStep(props: {
  readonly draft: AssistantDraft;
  readonly patch: OnboardingState["patch"];
  readonly environmentId: string | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <StepHeading
        title={`What does ${props.draft.name.trim() || "it"} run on?`}
        line="Any AI on this computer. A plan you sign in to stays here for your other assistants too."
      />
      {props.environmentId ? (
        <AssistantPowerPicker
          environmentId={props.environmentId as EnvironmentId}
          value={props.draft.brain}
          onChange={(brain) => props.patch({ brain })}
          note="Only for this assistant: Uno and the others keep theirs."
        />
      ) : (
        <p className="text-sm text-muted-foreground">Uno AI — no computer is connected yet.</p>
      )}
    </div>
  );
}

const toggle = (list: ReadonlyArray<string>, item: string) =>
  list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item];

function WhoStep(props: {
  readonly draft: AssistantDraft;
  readonly patch: OnboardingState["patch"];
  readonly isUno: boolean;
}) {
  const { draft, patch } = props;
  const skills = roleSkills(draft.roles);
  return (
    <div className="flex flex-col gap-4">
      <StepHeading title="Who is it?" />
      <div className="flex items-center gap-3">
        <AssistantAvatar
          emoji={draft.emoji}
          tone={draft.tone}
          className="size-12"
          emojiClassName="text-2xl"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Input
            aria-label="Name"
            placeholder="Name — Scout, Builder, Ada…"
            value={draft.name}
            onChange={(event) => patch({ name: event.currentTarget.value })}
            data-testid="assistant-setup-name"
          />
        </div>
        {props.isUno ? null : (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              const next = nextAvatar(draft.emoji, Date.now());
              patch({ emoji: next.emoji, tone: next.tone });
            }}
          >
            <DicesIcon className="size-3.5" /> New face
          </Button>
        )}
      </div>
      <section className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Role</span>
        <div className="flex flex-wrap gap-1.5">
          {ROLE_CHIPS.map((role) => (
            <Chip
              key={role}
              on={draft.roles.includes(role)}
              onClick={() => patch(toggleRole(draft, role))}
            >
              {role}
            </Chip>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Character</span>
        <div className="flex flex-wrap gap-1.5">
          {CHARACTER_CHIPS.map((character) => (
            <Chip
              key={character}
              on={draft.character === character}
              onClick={() => patch({ character })}
            >
              {character}
            </Chip>
          ))}
        </div>
        <Input
          size="sm"
          placeholder="Or in your words: “jokes a little, never over-explains”"
          value={
            (CHARACTER_CHIPS as ReadonlyArray<string>).includes(draft.character)
              ? ""
              : draft.character
          }
          onChange={(event) => patch({ character: event.currentTarget.value })}
        />
      </section>
      <section className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">Skills</span>
        <div className="flex flex-wrap gap-1.5">
          {skills.length === 0 ? (
            <span className="text-xs text-muted-foreground">Pick a role to see its skills.</span>
          ) : null}
          {skills.map((skill) => (
            <Chip
              key={skill}
              on={draft.skills.includes(skill)}
              onClick={() => patch({ skills: toggle(draft.skills, skill) })}
            >
              {skill}
            </Chip>
          ))}
        </div>
      </section>
    </div>
  );
}

function ReadyStep(props: {
  readonly draft: AssistantDraft;
  readonly team: ReadonlyArray<TeamMember>;
  readonly isUno: boolean;
  readonly ready: Ready;
  readonly computerLabels: ReadonlyMap<string, string>;
  readonly onWriteHere: (task: string) => void;
}) {
  const { draft, ready } = props;
  const [task, setTask] = useState("");
  const [copied, setCopied] = useState(false);
  const rows: ReadonlyArray<[string, string]> = [
    ["Talk", CHANNEL_NAME[draft.channel]],
    [
      "Opens",
      `${projectsLine(draft.projects)} · ${draft.computers.map((id) => props.computerLabels.get(id) ?? "this computer").join(", ") || "this computer"}`,
    ],
    ["May", PRESET_NAME[draft.preset]],
    ...(props.isUno || draft.preset === "full"
      ? []
      : [["Lives on", `${ownLabel(draft)} — its own computer`] satisfies [string, string]]),
    [
      "AI",
      brainLine(
        { name: draft.name, brain: draft.brain },
        props.team.filter((member) => !member.revoked).map((member) => member.profile),
      ),
    ],
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <AssistantAvatar
          emoji={draft.emoji}
          tone={draft.tone}
          activity="idle"
          className="size-12"
          emojiClassName="text-2xl"
        />
        <div className="flex flex-col gap-0.5">
          <DialogTitle className="text-lg leading-tight">{draft.name} is ready</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {[draft.roles[0], draft.character].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-border px-3 py-2.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <section className="flex flex-col gap-2">
        <span className="text-sm font-medium">Write the first task</span>
        <Textarea
          rows={2}
          placeholder={
            draft.roles.includes("Marketing")
              ? "Every Monday: what competitors shipped last week"
              : draft.roles.includes("Developer")
                ? "Keep CI green on fishcode and tell me what broke"
                : "Every morning at 8: what's running, what needs me"
          }
          value={task}
          onChange={(event) => setTask(event.currentTarget.value)}
          data-testid="assistant-setup-first-task"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => props.onWriteHere(task)}
            data-testid="assistant-setup-write-here"
          >
            <MessageCircleIcon className="size-3.5" /> {task.trim() ? "Send here" : "Open the chat"}
          </Button>
          {ready.link ? (
            <>
              <Button size="sm" variant="outline" onClick={() => openInstallDocs(ready.link!)}>
                <SendIcon className="size-3.5" /> Open in Telegram
              </Button>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard?.writeText(ready.link!).then(() => setCopied(true))
                }
                className="inline-flex cursor-pointer items-center gap-1 truncate font-mono text-xs text-muted-foreground hover:text-foreground"
                title="Copy the link"
              >
                {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
                {ready.link.replace(/^https:\/\//, "")}
              </button>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

// ── The dialog ────────────────────────────────────────────────────────────

export function AssistantOnboardingDialog() {
  const state = useAssistantOnboarding();
  const { open, step, target, draft, ready, setStep, patch, setDraft, setReady, close } = state;
  const team = useAssistantTeam();
  const { environmentId: activeEnvironmentId } = useActiveMachine();
  const machines = useMachineRows();
  const upsert = useAssistantTeamStore((store) => store.upsert);
  const patchProfile = useAssistantTeamStore((store) => store.patch);
  const { handleNewThread } = useNewThreadHandler();
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  const isUno = target.kind === "existing" && target.projectId === "assistant-home";
  const homeEnvironmentId =
    target.kind === "existing" ? target.environmentId : (activeEnvironmentId ?? null);
  const computerLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const machine of machines)
      if (machine.environmentId) map.set(machine.environmentId, machine.label);
    return map;
  }, [machines]);

  // A fresh draft each time it opens.
  useEffect(() => {
    if (!open || draft !== null) return;
    const existing =
      target.kind === "existing"
        ? team.find(
            (member) =>
              member.environmentId === target.environmentId &&
              member.projectId === target.projectId,
          )
        : undefined;
    const base = defaultDraft({
      thisComputer: homeEnvironmentId,
      existing: team.map((member) => member.profile),
      forUno: isUno,
    });
    setDraft(
      existing && !isUno
        ? {
            ...base,
            name: existing.profile.name,
            emoji: existing.profile.emoji,
            tone: existing.profile.tone,
          }
        : base,
    );
  }, [draft, homeEnvironmentId, isUno, open, setDraft, target, team]);

  if (!open || draft === null) return null;

  const later = () => {
    if (target.kind === "existing") {
      const key = assistantKeyOf(target.environmentId, target.projectId);
      patchProfile(key, { setUpAt: new Date().toISOString() });
    }
    close();
  };

  const create = async () => {
    if (homeEnvironmentId === null) return;
    setCreating(true);
    try {
      const name = isUno
        ? draft.name.trim() || "Uno"
        : uniqueName(
            draft.name,
            team
              .filter(
                (member) => !(target.kind === "existing" && member.projectId === target.projectId),
              )
              .map((member) => member.profile.name),
          );
      let projectId: string;
      if (target.kind === "existing") {
        projectId = target.projectId;
      } else {
        const created = await createAssistant({
          environmentId: homeEnvironmentId as EnvironmentId,
          name,
          ...(draft.emoji ? { emoji: draft.emoji } : {}),
        });
        projectId = created.projectId;
      }
      const now = new Date().toISOString();
      upsert({
        environmentId: homeEnvironmentId,
        projectId,
        name,
        emoji: draft.emoji,
        tone: draft.tone,
        roles: draft.roles,
        character: draft.character,
        skills: draft.skills,
        preset: draft.preset,
        brain: draft.brain,
        channel: draft.channel,
        channelHandle: null,
        projects: draft.projects,
        computers: draft.computers,
        createdBy: null,
        createdAt: now,
        setUpAt: now,
        revokedAt: null,
        access: draft.access,
        // Limited rights live on a computer of their own (16.10). The new Lite
        // one is made by the console's computer flow — the mock keeps its name.
        ownComputer: !isUno && draft.preset !== "full" ? ownLabel({ ...draft, name }) : null,
      });
      let link: string | null = null;
      if (draft.channel === "uno-bot") {
        link = await startTelegramPairing({
          environmentId: homeEnvironmentId as EnvironmentId,
          projectId,
        })
          .then((pairing) => pairing.link)
          .catch(() => null);
      }
      patch({ name });
      setReady({ environmentId: homeEnvironmentId, projectId, link });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't set it up",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCreating(false);
    }
  };

  const writeHere = async (task: string) => {
    if (!ready) return;
    close();
    await handleNewThread(
      scopeProjectRef(ready.environmentId as EnvironmentId, ready.projectId as ProjectId),
      { envMode: "local" },
    );
    const match = /\/draft\/([^/?#]+)/.exec(router.state.location.pathname);
    if (match && task.trim()) {
      useComposerDraftStore.getState().setPrompt(match[1] as DraftId, task.trim());
    }
  };

  const canNext =
    step === 2
      ? draft.projects === "all" || draft.projects.length > 0
      : step === 5
        ? draft.name.trim().length > 0
        : true;

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
      <DialogPopup
        className="max-w-[34rem]"
        showCloseButton={step > 0}
        data-testid="assistant-setup"
        data-step={step}
      >
        {/* One height for every step (critics 16.10): the window doesn't jump. */}
        <div className="flex h-[min(37rem,85vh)] flex-col gap-5 p-6">
          {step > 0 && step <= STEP_COUNT ? (
            <div className="flex items-center gap-3 pr-8">
              <div
                className="flex flex-1 gap-1"
                aria-label={`Step ${Math.min(step, STEP_COUNT)} of ${STEP_COUNT}`}
              >
                {Array.from({ length: STEP_COUNT }, (_, index) => (
                  <span
                    key={index}
                    className={cn(
                      "h-1 flex-1 rounded-full",
                      index < step ? "bg-primary" : "bg-muted",
                    )}
                  />
                ))}
              </div>
              <span className="text-xs text-muted-foreground tabular-nums">
                {Math.min(step, STEP_COUNT)} / {STEP_COUNT}
              </span>
            </div>
          ) : null}

          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
            {step === 0 ? (
              <IntroStep
                isUno={isUno || (target.kind === "new" && team.length === 0)}
                name={draft.name}
                emoji={draft.emoji}
                tone={draft.tone}
              />
            ) : step === 1 ? (
              <ChannelStep draft={draft} patch={patch} />
            ) : step === 2 ? (
              <AccessStep
                draft={draft}
                patch={patch}
                thisComputer={homeEnvironmentId}
                isUno={isUno}
              />
            ) : step === 3 ? (
              <RightsStep
                draft={draft}
                patch={patch}
                isUno={isUno}
                homeEnvironmentId={homeEnvironmentId}
              />
            ) : step === 4 ? (
              <BrainStep draft={draft} patch={patch} environmentId={homeEnvironmentId} />
            ) : step === 5 ? (
              <WhoStep draft={draft} patch={patch} isUno={isUno} />
            ) : ready ? (
              <ReadyStep
                draft={draft}
                team={team}
                isUno={isUno}
                ready={ready}
                computerLabels={computerLabels}
                onWriteHere={(task) => void writeHere(task)}
              />
            ) : null}
          </div>

          {step === 0 ? (
            <div className="flex flex-col items-center gap-2">
              <Button
                className="w-full max-w-sm"
                onClick={() => setStep(1)}
                data-testid="assistant-setup-start"
              >
                Set up in a minute
              </Button>
              <Button variant="ghost" size="sm" onClick={later}>
                Later
              </Button>
            </div>
          ) : step < STEP_COUNT ? (
            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={() => setStep(step - 1)}>
                <ArrowLeftIcon className="size-3.5" /> Back
              </Button>
              {step === 5 ? (
                <Button
                  size="sm"
                  disabled={!canNext || creating}
                  onClick={() => void create()}
                  data-testid="assistant-setup-create"
                >
                  {creating
                    ? "Setting up…"
                    : isUno
                      ? "Done"
                      : `Create ${draft.name.trim() || "assistant"}`}
                  <CheckIcon className="size-3.5" />
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={!canNext}
                  onClick={() => setStep(step + 1)}
                  data-testid="assistant-setup-next"
                >
                  Next <ArrowRightIcon className="size-3.5" />
                </Button>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <LaptopIcon className="size-3.5 shrink-0" />
                <span className="min-w-0">
                  {!isUno && draft.preset !== "full"
                    ? `Lives on ${ownLabel(draft)}, its own computer — keeps working when your laptop is closed.`
                    : null}
                  {!isUno && draft.preset !== "full" ? null : (
                    <>
                      Lives on {computerLabels.get(ready?.environmentId ?? "") ?? "this computer"}
                      {machines.find((machine) => machine.environmentId === ready?.environmentId)
                        ?.kind === "computer"
                        ? " — it pauses while this computer sleeps; on a cloud computer it keeps working."
                        : " — works even when your laptop is closed."}
                    </>
                  )}
                </span>
              </span>
              <Button variant="ghost" size="sm" onClick={close}>
                Close
              </Button>
            </div>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
