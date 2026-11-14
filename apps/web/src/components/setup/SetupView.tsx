/**
 * `/setup?step=…` — the guided setup inside the app (the sidebar stays).
 * Opening a step counts as visiting it, so the sidebar's "Set up N/8" (the
 * developer way: "N/3") moves as the person goes, and skipped steps can be
 * finished later. `step=start` is the three ways to use the computer.
 */
import { useSearch } from "@tanstack/react-router";
import { type ComponentType, useEffect } from "react";

import { flowOfStep, markVisited, withSetupFlow, type AnySetupStepId } from "./setupModel";
import { AiStep } from "./steps/AiStep";
import { DevFirstChatStep } from "./steps/DevFirstChatStep";
import { DevImportStep } from "./steps/DevImportStep";
import { DevSignInStep } from "./steps/DevSignInStep";
import { ChannelsStep } from "./steps/ChannelsStep";
import { ConnectorsStep } from "./steps/ConnectorsStep";
import { DoneStep } from "./steps/DoneStep";
import { InstructionsStep } from "./steps/InstructionsStep";
import { MaterialsStep } from "./steps/MaterialsStep";
import { ProjectStep } from "./steps/ProjectStep";
import { SkillsStep } from "./steps/SkillsStep";
import { TourDoneStep } from "./steps/TourDoneStep";
import { GoalStep } from "./steps/GoalStep";
import { WelcomeStep } from "./steps/WelcomeStep";
import { useUpdateSetupProgress } from "./useSetupProgress";

const STEP_VIEW: Readonly<Record<AnySetupStepId, ComponentType>> = {
  ai: AiStep,
  project: ProjectStep,
  instructions: InstructionsStep,
  skills: SkillsStep,
  connectors: ConnectorsStep,
  channels: ChannelsStep,
  materials: MaterialsStep,
  done: DoneStep,
  "sign-in": DevSignInStep,
  import: DevImportStep,
  "first-chat": DevFirstChatStep,
};

export function SetupView() {
  const { step, one } = useSearch({ from: "/_chat/setup" });
  const update = useUpdateSetupProgress();

  useEffect(() => {
    if (step === "tour-done" || step === "welcome" || step === "start") return;
    // One step from Home's Next step card: not the eight-step path — opening
    // it is not "visited" (the card counts a visited step as done, and the
    // sidebar's "Set up N/8" would appear). Continue records it (completeStep).
    if (one) return;
    // Any of the eight steps is the AI path, even after the tour; any of the
    // developer's three is that way.
    void update((current) => markVisited(withSetupFlow(current, flowOfStep(step)), step));
  }, [one, step, update]);

  if (step === "welcome") return <GoalStep />;
  if (step === "start") return <WelcomeStep />;
  if (step === "tour-done") return <TourDoneStep />;
  const View = STEP_VIEW[step];
  return <View key={step} />;
}
