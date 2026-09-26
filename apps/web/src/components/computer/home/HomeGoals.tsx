/**
 * Home for a newcomer (meeting feedback 25.09): under the composer, the four
 * goals as buttons (the same screens as the first start), and after the
 * first result one next step beyond the ready scenario. Home also notices
 * the first result of goals Uno builds in a chat (a published site, a
 * running bot) and "built something of their own" for the funnel.
 */
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { isAssistantProjectId, type UnoMachineApp } from "@t3tools/contracts";
import {
  BotIcon,
  GlobeIcon,
  SparklesIcon,
  UserRoundIcon,
  WandSparklesIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo } from "react";

import { trackFunnel } from "../../../lib/funnel";
import {
  BUILT_OWN_KEY,
  GOAL_COPY,
  NEXT_STEP,
  NEXT_STEP_KEY,
  detectBuiltOwn,
  detectFirstResult,
  goalState,
  withAnswer,
  withFirstResult,
  type GoalId,
} from "../../setup/goals";
import { useSetupProgress, useUpdateSetupProgress } from "../../setup/useSetupProgress";
import { sitesQuery } from "../../myuno/myUnoQueries";
import { Button } from "../../ui/button";
import type { HomeThread } from "./homeModel";

const HOME_GOALS: ReadonlyArray<{ goal: GoalId; icon: LucideIcon; via: string }> = [
  { goal: "assistant", icon: UserRoundIcon, via: "uno_ai" },
  { goal: "site", icon: GlobeIcon, via: "uno_ai" },
  { goal: "bot", icon: BotIcon, via: "uno_ai" },
  { goal: "own_agent", icon: SparklesIcon, via: "own_agent" },
];

export function HomeGoalButtons() {
  const navigate = useNavigate();
  return (
    <div className="flex flex-wrap gap-2" data-testid="home-goals">
      {HOME_GOALS.map(({ goal, icon: Icon, via }) => (
        <button
          key={goal}
          type="button"
          onClick={() => {
            trackFunnel("onboarding_goal_selected", { goal, props: { from: "home" } });
            void navigate({
              to: "/setup",
              search: {
                step: "welcome",
                goal,
                via: via as "uno_ai" | "own_agent",
              },
            });
          }}
          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm transition-colors hover:border-primary/50 hover:bg-primary/[0.04]"
          data-testid={`home-goal-${goal}`}
        >
          <Icon className="size-3.5 text-primary" />
          {GOAL_COPY[goal].button}
        </button>
      ))}
    </div>
  );
}

/** First result / built-own detection, while Home is open. */
export function useGoalWatcher(input: {
  readonly threads: ReadonlyArray<HomeThread>;
  readonly machineApps: ReadonlyArray<UnoMachineApp>;
}) {
  const progress = useSetupProgress();
  const update = useUpdateSetupProgress();
  const state = goalState(progress);
  const watchSites = state.goal === "site" && !state.firstResultAt;
  const sites = useQuery({ ...sitesQuery(), enabled: watchSites, refetchInterval: 20_000 });

  const firstVia = detectFirstResult(state, {
    sites: sites.data?.sites ?? [],
    apps: input.machineApps,
  });
  useEffect(() => {
    if (!firstVia || !state.goal) return;
    const goal = state.goal;
    trackFunnel("first_result", { goal, props: { via: firstVia } });
    void update((current) => withFirstResult(current, goal));
  }, [firstVia, state.goal, update]);

  const builtOwn = useMemo(
    () =>
      detectBuiltOwn(
        state,
        input.threads.map((thread) => ({
          createdAt: thread.createdAt,
          completedAt: thread.latestTurn?.completedAt ?? null,
          isAssistant: isAssistantProjectId(thread.projectId),
        })),
      ),
    [input.threads, state],
  );
  useEffect(() => {
    if (!builtOwn) return;
    trackFunnel("built_own", { goal: state.goal });
    void update((current) =>
      current.answers[BUILT_OWN_KEY]
        ? current
        : withAnswer(current, BUILT_OWN_KEY, new Date().toISOString()),
    );
  }, [builtOwn, state.goal, update]);
}

/** One idea beyond the ready scenario, once the first result is there. */
export function HomeNextStep({
  onStartTask,
  onAskUno,
}: {
  onStartTask: (prompt: string, folder: string) => void;
  onAskUno: (prompt: string) => void;
}) {
  const progress = useSetupProgress();
  const update = useUpdateSetupProgress();
  const state = goalState(progress);
  const show =
    state.goal !== null &&
    state.firstResultAt !== null &&
    state.nextStep !== "closed" &&
    state.nextStep !== "clicked";
  const goal = state.firstResultGoal ?? state.goal;
  useEffect(() => {
    if (show && goal) trackFunnel("next_step_shown", { goal });
  }, [goal, show]);
  if (!show || !goal) return null;
  const idea = NEXT_STEP[goal];
  const act = () => {
    trackFunnel("next_step_clicked", { goal });
    void update((current) => withAnswer(current, NEXT_STEP_KEY, "clicked"));
    if (state.projectPath) onStartTask(idea.prompt, state.projectPath);
    else onAskUno(idea.prompt);
  };
  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-dashed border-primary/40 bg-primary/[0.03] px-3 py-2.5"
      data-testid="home-next-step"
    >
      <WandSparklesIcon className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 text-sm">
        <span className="font-medium">Next step: </span>
        <span className="text-muted-foreground">{idea.title}</span>
      </span>
      {idea.prompt ? (
        <Button size="sm" variant="outline" onClick={act}>
          Do it
        </Button>
      ) : null}
      <button
        type="button"
        aria-label="Not now"
        onClick={() => void update((current) => withAnswer(current, NEXT_STEP_KEY, "closed"))}
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
