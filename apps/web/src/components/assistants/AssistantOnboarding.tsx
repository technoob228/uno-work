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
 */
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime";
import { useRouter } from "@tanstack/react-router";
import { DicesIcon, MessageCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
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
import { type TeamMember, useAssistantTeam } from "./useAssistantTeam";

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
  /** `step` is kept for older callers; the form is one screen now. */
  readonly openNew: (step?: number) => void;
  readonly openFor: (member: Pick<TeamMember, "environmentId" | "projectId" | "profile">) => void;
  readonly patch: (patch: Partial<AssistantDraft>) => void;
  readonly setDraft: (draft: AssistantDraft) => void;
  readonly close: () => void;
}

export const useAssistantOnboarding = create<OnboardingState>((set, get) => ({
  open: false,
  target: { kind: "new" },
  draft: null,
  openNew: () => set({ open: true, target: { kind: "new" }, draft: null }),
  openFor: (member) =>
    set({
      open: true,
      target: {
        kind: "existing",
        environmentId: member.environmentId,
        projectId: member.projectId,
        name: member.profile.name,
      },
      draft: null,
    }),
  patch: (patch) => {
    const draft = get().draft;
    if (draft) set({ draft: { ...draft, ...patch } });
  },
  setDraft: (draft) => set({ draft }),
  close: () => set({ open: false }),
}));

// ── The dialog: a name and an AI, then the chat ───────────────────────────

export function AssistantOnboardingDialog() {
  const { open, target, draft, patch, setDraft, close } = useAssistantOnboarding();
  const team = useAssistantTeam();
  const { environmentId: activeEnvironmentId } = useActiveMachine();
  const upsert = useAssistantTeamStore((store) => store.upsert);
  const patchProfile = useAssistantTeamStore((store) => store.patch);
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
      patchProfile(assistantKeyOf(target.environmentId, target.projectId), {
        setUpAt: new Date().toISOString(),
      });
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
      // one answer at a time.
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
              <AssistantPowerPicker
                environmentId={homeEnvironmentId as EnvironmentId}
                value={draft.brain}
                onChange={(brain) => patch({ brain })}
                note={`Only for ${name || "it"}. A plan’s limit is shared with your own chats.`}
              />
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
