/**
 * Home's ONE next step (Misha 27.09: "Home must depend on the person's stage
 * and goal — simple like the Grok bot, and the power still shows"). The step
 * comes from the account (`GET /api/v1/account/next-step`, the same answer the
 * console's Overview shows). Work only renders it — no rules here. Every step
 * has one button and "Not now".
 */
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, WandSparklesIcon } from "lucide-react";
import { useEffect, useMemo } from "react";

import { CONSOLE_URL } from "../../../account/accountOverview";
import { useAssistantChat } from "../../../assistant/useAssistantChat";
import { trackFunnel } from "../../../lib/funnel";
import { useDevMode } from "../../../devMode";
import { isWebLite } from "../../../lite/webLite";
import { accountResumeQuery, nextStepQuery } from "../../myuno/myUnoQueries";
import { openInstallDocs } from "../../onboarding/harnessInstallLinks";
import { NEXT_STEP, goalState, withAnswer, type GoalId } from "../../setup/goals";
import { useSetupProgress, useUpdateSetupProgress } from "../../setup/useSetupProgress";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import { HomeGoalButtons } from "./HomeGoals";
import {
  parseNextStepPlan,
  nextStepChatId,
  nextStepDoneKey,
  nextStepSkipKey,
  visibleNextStep,
  withoutSshFirst,
  type NextStepItem,
  type NextStepPlan,
} from "./nextStep";

export interface HomeNextStepState {
  readonly plan: NextStepPlan | null;
  readonly step: NextStepItem | null;
  /** "Connect with SSH", when it was moved under the card for a non-developer. */
  readonly developerStep?: NextStepItem | null;
}

/** The account's answer (null while loading or when the account can't be read). */
export function useNextStep(): HomeNextStepState {
  const progress = useSetupProgress();
  const backend = useQuery(nextStepQuery());
  const plan = useMemo(() => parseNextStepPlan(backend.data), [backend.data]);
  const devMode = useDevMode();
  const answers = progress.answers ?? {};
  const { step, developerStep } = withoutSshFirst(
    plan,
    visibleNextStep(plan, answers),
    answers,
    devMode,
  );
  return { plan, step, developerStep };
}

/** Work's own words and button per step; the backend's title is the fallback. */
const WORK_COPY: Readonly<Record<string, { title: string; hint: string; button: string }>> = {
  pick_goal: {
    title: "What do you want to do first?",
    hint: "Pick one. Uno sets it up, everything else can wait.",
    button: "",
  },
  connect_agent: {
    title: "Connect your Claude Code or Codex",
    hint: "One line to paste. Your agent then works on this computer, even when your laptop is closed.",
    button: "Connect my agent",
  },
  agent_publish_site: {
    title: "Ask your agent to publish a site",
    hint: "Tell it: “Publish this folder on Uno and send me the link.” Sites are free.",
    button: "Copy the ask",
  },
  agent_gets_computer: {
    title: "Give your agent a computer that stays on",
    hint: "For bots and anything that runs 24/7. From Small, $5 a month.",
    button: "See plans",
  },
  describe_site: {
    title: "Describe your site",
    hint: "Or drop a folder. Uno builds it and sends you a live link.",
    button: "Make my site",
  },
  site_add_form: {
    title: "Add a sign-up form to your site",
    hint: "Answers come to your Telegram and a table you can open.",
    button: "Add a form",
  },
  get_computer: {
    title: "Get a computer for your bot",
    hint: "A bot has to run 24/7. From Small, $5 a month.",
    button: "See plans",
  },
  describe_bot: {
    title: "Tell Uno what your bot does",
    hint: "Uno builds it, runs it 24/7 and tells you when to write to it.",
    button: "Make my bot",
  },
  bot_save_orders: {
    title: "Save every order to a table you own",
    hint: "And a short summary every evening.",
    button: "Do it",
  },
  get_ai_hours: {
    title: "Turn on AI first",
    hint: "Uno AI is out of AI time. Add AI time, or use your own ChatGPT or Claude subscription.",
    button: "Turn on AI",
  },
  talk_to_uno: {
    title: "Talk to Uno",
    hint: "Ask for anything: a site, a table, a bot. It works on this computer.",
    button: "Talk to Uno",
  },
  connect_telegram: {
    title: "Write to Uno in Telegram",
    hint: "It answers day and night, even when your laptop is closed.",
    button: "Connect Telegram",
  },
  morning_plan: {
    title: "Get a short plan for your day every morning",
    hint: "In Telegram, at 9. Uno asks what to include first.",
    button: "Set it up",
  },
  create_computer: {
    title: "Start your server",
    hint: "A clean Linux computer, always on.",
    button: "Start it",
  },
  connect_ssh: {
    title: "Connect with SSH or your agent",
    hint: "Add your SSH key, or give your agent a key to this computer.",
    button: "Connect",
  },
  install_app: {
    title: "Put your first app on it",
    hint: "Tell Uno what to run. It sets it up and keeps it running.",
    button: "Start",
  },
};

export const AGENT_PUBLISH_ASK = "Publish this folder on Uno and send me the link.";

export function HomeNextStepCard({
  state,
  onStartTask,
  onAskUno,
}: {
  state: HomeNextStepState;
  onStartTask: (prompt: string, folder: string) => void;
  onAskUno: (prompt: string) => void;
}) {
  const navigate = useNavigate();
  const progress = useSetupProgress();
  const update = useUpdateSetupProgress();
  const assistant = useAssistantChat();
  const resume = useQuery(accountResumeQuery());
  const { plan, step } = state;
  const goal = plan?.goal ?? null;
  const projectPath = goalState(progress).projectPath;

  useEffect(() => {
    if (step)
      trackFunnel("next_step_shown", {
        goal,
        props: { step_id: step.id, source: plan?.source ?? "" },
      });
  }, [goal, plan?.source, step]);

  if (!step) return null;
  const copy = WORK_COPY[step.id];
  const title = copy?.title ?? step.title;
  const hint = copy?.hint ?? step.hint;

  const mark = (key: string) =>
    void update((current) => withAnswer(current, key, new Date().toISOString()));
  const setup = (to: GoalId, via: "uno_ai" | "own_agent" | "ssh") =>
    void navigate({ to: "/setup", search: { step: "welcome", goal: to, via } });
  const inProject = (prompt: string) =>
    projectPath ? onStartTask(prompt, projectPath) : onAskUno(prompt);
  const openConsole = () =>
    openInstallDocs(
      `${CONSOLE_URL}${step.consolePath && step.consolePath.startsWith("/") ? step.consolePath : "/"}`,
    );

  // The chat where the person already described this (B2): open it, not a new one.
  // "Talk to Uno" on a computer is the assistant's own chat, already one and the same.
  const sameChatId =
    step.id === "talk_to_uno" && !isWebLite ? null : nextStepChatId(step.id, resume.data);

  const act = () => {
    trackFunnel("next_step_clicked", {
      goal,
      props: { step_id: step.id, ...(sameChatId ? { same_chat: "1" } : {}) },
    });
    if (sameChatId) return void navigate({ to: "/ai", search: { chat: sameChatId } });
    switch (step.id) {
      case "connect_agent":
        return setup("own_agent", "own_agent");
      case "connect_ssh":
        return setup("server", "ssh");
      case "describe_site":
        return setup("site", "uno_ai");
      case "describe_bot":
        return setup("bot", "uno_ai");
      case "connect_telegram":
        return setup("assistant", "uno_ai");
      case "talk_to_uno":
        return void assistant.open();
      case "agent_publish_site":
        void navigator.clipboard?.writeText(AGENT_PUBLISH_ASK).then(
          () => toastManager.add({ type: "success", title: "Copied. Paste it to your agent." }),
          () => undefined,
        );
        return;
      case "site_add_form":
        mark(nextStepDoneKey(step.id));
        return inProject(NEXT_STEP.site.prompt);
      case "bot_save_orders":
        mark(nextStepDoneKey(step.id));
        return inProject(NEXT_STEP.bot.prompt);
      case "morning_plan":
        mark(nextStepDoneKey(step.id));
        return onAskUno(NEXT_STEP.assistant.prompt);
      case "install_app":
        mark(nextStepDoneKey(step.id));
        return onAskUno(NEXT_STEP.server.prompt);
      default:
        // get_ai_hours, get_computer, agent_gets_computer, create_computer, unknown ids.
        return openConsole();
    }
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-2xl border border-primary/30 bg-primary/[0.04] p-4"
      data-testid="home-next-step"
      data-step={step.id}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
          <WandSparklesIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium tracking-wide text-primary uppercase">Next step</p>
          <p className="text-base font-semibold text-foreground" data-testid="home-next-step-title">
            {title}
          </p>
          {hint ? <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p> : null}
        </div>
      </div>
      {step.id === "pick_goal" ? (
        <HomeGoalButtons />
      ) : (
        <div className="flex flex-wrap items-center gap-2 ps-11">
          <Button size="sm" onClick={act} data-testid="home-next-step-do">
            {copy?.button || "Open"}
            <ArrowRightIcon className="size-3.5" />
          </Button>
          <button
            type="button"
            onClick={() => mark(nextStepSkipKey(step.id))}
            className="rounded-full px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="home-next-step-skip"
          >
            Not now
          </button>
        </div>
      )}
      {state.developerStep ? (
        <p className="ps-11 text-xs text-muted-foreground" data-testid="home-next-step-developers">
          For developers:{" "}
          <button
            type="button"
            onClick={() => setup("server", "ssh")}
            className="underline underline-offset-2 hover:text-foreground"
          >
            connect with SSH or your own agent
          </button>
        </p>
      ) : null}
    </div>
  );
}
