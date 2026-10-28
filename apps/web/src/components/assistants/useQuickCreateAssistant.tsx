/**
 * "+" makes an assistant in one click and opens its page (Misha 23.10), where
 * the one next step is Connect Telegram. Every way in leads here: "+" in the
 * sidebar, New assistant on its page and under Assistants
 * (`/assistants?view=new`), and Home's quiz (its plan comes along).
 *
 * The rules are in `quickCreateAssistant.ts`; here: the computer it goes on
 * (the one the app is looking at), waiting until its folder reaches this
 * window, and the page.
 */
import { type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { createAssistant, updateAssistantTeam } from "../../lib/managerApi";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { toastManager } from "../ui/toast";
import { quizPlanHandoff } from "./assistantQuizApi";
import { createLocalAssistant } from "./createAssistant";
import { quickCreateAssistant } from "./quickCreateAssistant";
import { useAssistantTeam } from "./useAssistantTeam";
import { LOCAL_ASSISTANTS_KEY, makeLocalCreateDeps, useBoxIdOfEnvironment } from "./useAssistants";

/** One creation at a time, whichever "+" was clicked. */
const useCreating = create<{ readonly creating: boolean; readonly set: (on: boolean) => void }>(
  (set) => ({ creating: false, set: (creating) => set({ creating }) }),
);

/** Its folder reached this window (the sidebar and its page can show it). */
async function waitForProject(environmentId: string, projectId: string): Promise<void> {
  const here = () =>
    selectProjectsAcrossEnvironments(useStore.getState()).some(
      (project) => project.environmentId === environmentId && project.id === projectId,
    );
  for (let tries = 0; tries < 50 && !here(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function useQuickCreateAssistant() {
  const team = useAssistantTeam();
  const { environmentId } = useActiveMachine();
  const boxId = useBoxIdOfEnvironment(environmentId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const creating = useCreating((state) => state.creating);
  const setCreating = useCreating((state) => state.set);

  const createNow = async (): Promise<boolean> => {
    if (environmentId === null || useCreating.getState().creating) return false;
    setCreating(true);
    try {
      const target = environmentId as EnvironmentId;
      const plan = quizPlanHandoff.take();
      const made = await quickCreateAssistant(
        {
          createAssistant: (input) => createAssistant({ environmentId: target, ...input }),
          createFromPlan: (withFace) =>
            createLocalAssistant(
              withFace,
              makeLocalCreateDeps(target, boxId, () => undefined),
            ),
          finish: (projectId, input) =>
            updateAssistantTeam({ environmentId: target, projectId, ...input }).then(
              () => undefined,
            ),
          random: Math.random,
        },
        {
          existing: team
            .filter((member) => member.environmentId === environmentId)
            .map((member) => ({ name: member.profile.name, emoji: member.profile.emoji })),
          plan,
        },
      );
      await waitForProject(environmentId, made.projectId);
      await queryClient.invalidateQueries({ queryKey: LOCAL_ASSISTANTS_KEY });
      await navigate({
        to: "/assistants",
        search: { view: "profile", env: environmentId, project: made.projectId as ProjectId },
      });
      return true;
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Couldn't make an assistant",
        description: cause instanceof Error && cause.message ? cause.message : String(cause),
      });
      return false;
    } finally {
      setCreating(false);
    }
  };

  return { create: createNow, creating, available: environmentId !== null };
}

/**
 * `/assistants?view=new`: makes one right away and opens its page; back to
 * the list if it couldn't.
 */
export function QuickCreateAssistantView() {
  const { create: createNow, available } = useQuickCreateAssistant();
  const navigate = useNavigate();
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !available) return;
    started.current = true;
    void createNow().then((made) => {
      if (!made) void navigate({ to: "/assistants" });
    });
  }, [available, createNow, navigate]);
  return (
    <p
      className="flex items-center gap-2 text-sm text-muted-foreground"
      data-testid="assistant-quick-create"
    >
      <LoaderCircleIcon className="size-4 animate-spin" />
      Making your assistant…
    </p>
  );
}
