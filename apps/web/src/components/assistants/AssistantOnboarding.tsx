/**
 * Setting up an assistant (Misha 16.10): only the minimum by buttons — its
 * name (filled in) and the AI it runs on — and then a real chat with it,
 * where it sets itself up by talking, like Grok's companions: it introduces
 * itself and asks one question at a time — who it is and what it does, then
 * where you talk, what it may do and use (apps with levels, the browser and
 * logins, keys, its own computer when limited), how it reports, and last the
 * first task. Quiz cards with 2–4 answers plus your own words, a short field
 * where a value is needed, a Connect button for an app, Skip on each; every
 * answer is saved to its profile at once ("✓ Saved: …").
 *
 * The questions are the steps of strategy/ASSISTANT_SETUP_FLOW.md and
 * TEAMMATES_GROOMING.md; its page shows all of it afterwards and edits it.
 * It takes tasks only from the person — never a public bot.
 *
 * The team and its chat setup show with the assistants update on the account
 * (`useTeamShown`, 22.10) and in the mock (`?demo=w0138`). Without it, Uno
 * alone (Misha 16.10): its first click says who it is, then one screen — what
 * it runs on — and the first chat (`UnoIntroDialog`).
 */
import {
  ASSISTANT_PROJECT_ID,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime";
import { useRouter } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  DicesIcon,
  HandIcon,
  MessageCircleIcon,
  SendIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { create } from "zustand";

import { useAssistantChat } from "../../assistant/useAssistantChat";
import { DEMO_PROTOTYPE } from "../../demo/demoFlag";
import { useActiveMachine } from "../../hooks/useActiveMachine";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useMachineRows } from "../../hooks/useMachineRows";
import { createAssistant, startAssistantSetupChat } from "../../lib/managerApi";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../../store";
import { buildThreadRouteParams } from "../../threadRoutes";
import { AssistantPowerPicker } from "../assistant/AssistantPowerPicker";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { AssistantAvatar } from "./AssistantAvatar";
import {
  type AssistantDraft,
  assistantKeyOf,
  defaultDraft,
  nextAvatar,
  uniqueName,
} from "./assistantTeam.logic";
import { useAssistantTeamStore } from "./assistantTeamStore";
import { type TeamMember, useAssistantTeam, useTeamShown } from "./useAssistantTeam";
import { useTeamActions } from "./useTeamActions";

/** Uno's second bot — for assistants (the first one carries notifications). */
export const UNO_ASSISTANT_BOT = "uno_team_bot";

// ── Who opens it, and where it is ─────────────────────────────────────────

type Target =
  | { readonly kind: "new" }
  | {
      readonly kind: "existing";
      readonly environmentId: string;
      readonly projectId: string;
      readonly name: string;
    };

interface OnboardingState {
  readonly open: boolean;
  readonly target: Target;
  readonly draft: AssistantDraft | null;
  /**
   * Uno's short setup in the release (`UnoIntroDialog`): 0 — who it is,
   * 1 — what it runs on. The team's form in the mock is one screen.
   */
  readonly step: number;
  /** `step` is kept for older callers; the form is one screen now. */
  readonly openNew: (step?: number) => void;
  readonly openFor: (member: Pick<TeamMember, "environmentId" | "projectId" | "profile">) => void;
  readonly setStep: (step: number) => void;
  readonly patch: (patch: Partial<AssistantDraft>) => void;
  readonly setDraft: (draft: AssistantDraft) => void;
  readonly close: () => void;
}

export const useAssistantOnboarding = create<OnboardingState>((set, get) => ({
  open: false,
  step: 0,
  target: { kind: "new" },
  draft: null,
  openNew: () => set({ open: true, step: 0, target: { kind: "new" }, draft: null }),
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
    }),
  setStep: (step) => set({ step: Math.max(0, Math.min(1, step)) }),
  patch: (patch) => {
    const draft = get().draft;
    if (draft) set({ draft: { ...draft, ...patch } });
  },
  setDraft: (draft) => set({ draft }),
  close: () => set({ open: false }),
}));

// ── Uno's short setup (the release) ───────────────────────────────────────

function StepHeading(props: { readonly title: string; readonly line?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <DialogTitle className="text-lg leading-tight">{props.title}</DialogTitle>
      {props.line ? <p className="text-sm text-muted-foreground">{props.line}</p> : null}
    </div>
  );
}

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

/**
 * The release's setup of Uno (Misha 16.10): only Uno ships, on any AI on the
 * computer, with the whole computer open to it. The first click on Uno says
 * who it is, then one screen — what it runs on (the real computer-wide
 * choice, `AssistantPowerPicker`, in production since 0.0.134) — and the
 * first chat. The six steps and the team stay in the mock.
 */
function UnoIntroDialog() {
  const { open, step, target, setStep, close } = useAssistantOnboarding();
  const team = useAssistantTeam();
  const upsert = useAssistantTeamStore((store) => store.upsert);
  const { handleNewThread } = useNewThreadHandler();
  const assistantChat = useAssistantChat();
  const machines = useMachineRows();
  const [starting, setStarting] = useState(false);

  if (!open || target.kind !== "existing") return null;
  const member = team.find(
    (entry) => entry.environmentId === target.environmentId && entry.projectId === target.projectId,
  );
  const name = member?.profile.name ?? target.name;
  const computer =
    machines.find((machine) => machine.environmentId === target.environmentId)?.label ??
    "this computer";

  // Asked once: "Later" and "Start" both remember it (the profile may not be stored yet).
  const markSetUp = () => {
    if (member) upsert({ ...member.profile, setUpAt: new Date().toISOString() });
  };
  const later = () => {
    markSetUp();
    close();
  };
  const start = async () => {
    setStarting(true);
    try {
      markSetUp();
      close();
      // The first chat with Uno is its main one (Telegram and Slack talk to it).
      if (
        target.projectId === ASSISTANT_PROJECT_ID &&
        assistantChat.environmentId === target.environmentId
      ) {
        await assistantChat.open();
        return;
      }
      await handleNewThread(
        scopeProjectRef(target.environmentId as EnvironmentId, target.projectId as ProjectId),
        { envMode: "local" },
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
      <DialogPopup
        className="max-w-[34rem]"
        showCloseButton={step > 0}
        data-testid="assistant-setup"
        data-step={step}
        data-variant="uno"
      >
        <div className="flex max-h-[85vh] flex-col gap-5 p-6">
          <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
            {step === 0 ? (
              <IntroStep isUno name={name} emoji={null} tone={member?.profile.tone ?? "violet"} />
            ) : (
              <div className="flex flex-col gap-4">
                <StepHeading
                  title={`What does ${name} run on?`}
                  line="Any AI on this computer: Uno AI, your Claude or ChatGPT plan, or your own key. Change it any time in Settings → AI."
                />
                <AssistantPowerPicker environmentId={target.environmentId as EnvironmentId} />
                <div
                  className="flex items-start gap-2.5 rounded-xl border border-border bg-muted/30 p-3 text-sm"
                  data-testid="uno-setup-access"
                >
                  <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>
                    <span className="font-medium">Full access to {computer}.</span>{" "}
                    <span className="text-muted-foreground">
                      {name} can open your projects, files, apps and browser here, like you. It
                      takes tasks only from you.
                    </span>
                  </span>
                </div>
              </div>
            )}
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
          ) : (
            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={() => setStep(0)}>
                <ArrowLeftIcon className="size-3.5" /> Back
              </Button>
              <Button
                size="sm"
                disabled={starting}
                onClick={() => void start()}
                data-testid="assistant-setup-create"
              >
                Start a chat with {name} <ArrowRightIcon className="size-3.5" />
              </Button>
            </div>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

/** The setup: the team's chat setup in the mock, Uno's short one in the release. */
export function AssistantOnboardingDialog() {
  return useTeamShown() ? <TeamOnboardingDialog /> : <UnoIntroDialog />;
}

// ── The team's dialog (mock): a name and an AI, then the chat ─────────────

function TeamOnboardingDialog() {
  const { open, target, draft, patch, setDraft, close } = useAssistantOnboarding();
  const team = useAssistantTeam();
  const { environmentId: activeEnvironmentId } = useActiveMachine();
  const upsert = useAssistantTeamStore((store) => store.upsert);
  const patchProfile = useAssistantTeamStore((store) => store.patch);
  const actions = useTeamActions();
  const { handleNewThread } = useNewThreadHandler();
  const router = useRouter();
  const [starting, setStarting] = useState(false);

  const isUno = target.kind === "existing" && target.projectId === "assistant-home";
  const homeEnvironmentId =
    target.kind === "existing" ? target.environmentId : (activeEnvironmentId ?? null);
  const existing =
    target.kind === "existing"
      ? team.find(
          (member) =>
            member.environmentId === target.environmentId && member.projectId === target.projectId,
        )
      : undefined;

  // A fresh draft each time it opens.
  useEffect(() => {
    if (!open || draft !== null) return;
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
            brain: existing.profile.brain,
          }
        : existing
          ? { ...base, brain: existing.profile.brain }
          : base,
    );
  }, [draft, existing, homeEnvironmentId, isUno, open, setDraft, team]);

  if (!open || draft === null) return null;
  const name = draft.name.trim();

  const later = () => {
    if (target.kind === "existing") {
      if (DEMO_PROTOTYPE) {
        patchProfile(assistantKeyOf(target.environmentId, target.projectId), {
          setUpAt: new Date().toISOString(),
        });
      } else {
        // Its computer keeps "asked once": the first click opens its chat from now on.
        void actions.update(target, { setup: "done" }).catch(() => undefined);
      }
    }
    close();
  };

  const start = async () => {
    if (homeEnvironmentId === null || !name) return;
    setStarting(true);
    try {
      const finalName = isUno
        ? name || "Uno"
        : uniqueName(
            name,
            team
              .filter((member) => member.key !== existing?.key)
              .map((member) => member.profile.name),
          );
      const projectId =
        target.kind === "existing"
          ? target.projectId
          : (
              await createAssistant({
                environmentId: homeEnvironmentId as EnvironmentId,
                name: finalName,
                ...(draft.emoji ? { emoji: draft.emoji } : {}),
              })
            ).projectId;
      const now = new Date().toISOString();
      // Its profile starts with the defaults; the chat fills in the rest,
      // one answer at a time — on its computer (outside the mock).
      if (!DEMO_PROTOTYPE) {
        await actions
          .update(
            { environmentId: homeEnvironmentId, projectId },
            {
              tone: draft.tone,
              ...(target.kind === "existing" && !isUno
                ? { name: finalName, ...(draft.emoji ? { emoji: draft.emoji } : {}) }
                : {}),
            },
          )
          .catch(() => undefined);
      } else
        upsert({
          ...(existing?.profile ?? {
            roles: draft.roles,
            character: draft.character,
            skills: draft.skills,
            preset: draft.preset,
            channel: draft.channel,
            channelHandle: null,
            projects: draft.projects,
            computers: draft.computers,
            createdBy: null,
            createdAt: now,
            revokedAt: null,
            access: draft.access,
          }),
          environmentId: homeEnvironmentId,
          projectId,
          name: finalName,
          emoji: draft.emoji,
          tone: draft.tone,
          brain: draft.brain,
          setUpAt: null,
        });
      close();
      try {
        const { threadId } = await startAssistantSetupChat({
          environmentId: homeEnvironmentId as EnvironmentId,
          projectId,
        });
        // The chat reaches this window a moment later; open it once it's here.
        const arrived = () =>
          selectSidebarThreadsAcrossEnvironments(useStore.getState()).some(
            (thread) => thread.id === threadId,
          );
        for (let tries = 0; tries < 40 && !arrived(); tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams({
            environmentId: homeEnvironmentId as EnvironmentId,
            threadId: threadId as ThreadId,
          }),
        });
      } catch {
        // A daemon without the setup chat: an empty chat with it.
        await handleNewThread(
          scopeProjectRef(homeEnvironmentId as EnvironmentId, projectId as ProjectId),
          { envMode: "local" },
        );
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't set it up",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
      <DialogPopup className="max-w-[30rem]" data-testid="assistant-setup">
        <div className="flex max-h-[85vh] flex-col gap-5 overflow-y-auto p-6">
          <div className="flex items-center gap-3 pr-8">
            <button
              type="button"
              disabled={isUno}
              onClick={() => {
                const avatar = nextAvatar(draft.emoji, Date.now());
                patch({ emoji: avatar.emoji, tone: avatar.tone });
              }}
              title={isUno ? undefined : "Another face"}
              className="group relative shrink-0 cursor-pointer disabled:cursor-default"
            >
              <AssistantAvatar
                emoji={isUno ? null : draft.emoji}
                tone={draft.tone}
                className="size-12"
                emojiClassName="text-2xl"
              />
              {isUno ? null : (
                <span className="absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full border border-border bg-background text-muted-foreground group-hover:text-foreground">
                  <DicesIcon className="size-3" />
                </span>
              )}
            </button>
            <div className="flex min-w-0 flex-col gap-0.5">
              <DialogTitle className="text-lg leading-tight">
                {isUno
                  ? "Set up Uno"
                  : target.kind === "existing"
                    ? `Set up ${target.name}`
                    : "A new teammate"}
              </DialogTitle>
              <p className="text-sm text-muted-foreground">
                Two things here — the rest it asks you itself, in a chat.
              </p>
            </div>
          </div>

          {isUno ? null : (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Name</span>
              <Input
                value={draft.name}
                onChange={(event) => patch({ name: event.currentTarget.value })}
                placeholder="Ada"
                data-testid="assistant-setup-name"
              />
            </label>
          )}

          <section className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              What does {name || "it"} run on?
            </span>
            {homeEnvironmentId ? (
              DEMO_PROTOTYPE ? (
                <AssistantPowerPicker
                  environmentId={homeEnvironmentId as EnvironmentId}
                  value={draft.brain}
                  onChange={(brain) => patch({ brain })}
                  note={`Only for ${name || "it"}. A plan’s limit is shared with your own chats.`}
                />
              ) : (
                // One AI per computer for now: the computer-wide choice, said so.
                <AssistantPowerPicker environmentId={homeEnvironmentId as EnvironmentId} />
              )
            ) : (
              <p className="text-sm text-muted-foreground">
                Uno AI — no computer is connected yet.
              </p>
            )}
          </section>

          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" onClick={target.kind === "existing" ? later : close}>
              Later
            </Button>
            <Button
              disabled={starting || !name || homeEnvironmentId === null}
              onClick={() => void start()}
              data-testid="assistant-setup-start"
            >
              <MessageCircleIcon className="size-4" />
              {starting ? "Starting…" : `Start the chat with ${name || "it"}`}
            </Button>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
