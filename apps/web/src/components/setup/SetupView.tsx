/**
 * `/setup?step=…` — the guided setup inside the app (the sidebar stays).
 * Opening a step counts as visiting it, so the sidebar's "Set up N/8" moves
 * as the person goes, and skipped steps can be finished later.
 */
import { useSearch } from "@tanstack/react-router";
import { type ComponentType, useEffect } from "react";

import { markVisited, type SetupStepId } from "./setupModel";
import { AiStep } from "./steps/AiStep";
import { ChannelsStep } from "./steps/ChannelsStep";
import { ConnectorsStep } from "./steps/ConnectorsStep";
import { DoneStep } from "./steps/DoneStep";
import { InstructionsStep } from "./steps/InstructionsStep";
import { MaterialsStep } from "./steps/MaterialsStep";
import { ProjectStep } from "./steps/ProjectStep";
import { SkillsStep } from "./steps/SkillsStep";
import { TourDoneStep } from "./steps/TourDoneStep";
import { GoalStep } from "./steps/GoalStep";
import { useUpdateSetupProgress } from "./useSetupProgress";

const STEP_VIEW: Readonly<Record<SetupStepId, ComponentType>> = {
  ai: AiStep,
  project: ProjectStep,
  instructions: InstructionsStep,
  skills: SkillsStep,
  connectors: ConnectorsStep,
  channels: ChannelsStep,
  materials: MaterialsStep,
  done: DoneStep,
};

export function SetupView() {
  const { step } = useSearch({ from: "/_chat/setup" });
  const update = useUpdateSetupProgress();

  useEffect(() => {
    if (step === "tour-done" || step === "welcome") return;
    // Any of the eight steps is the AI path, even after the tour.
    void update((current) =>
      markVisited(current.mode === "ai" ? current : { ...current, mode: "ai" }, step),
    );
  }, [step, update]);

  if (step === "welcome") return <GoalStep />;
  if (step === "tour-done") return <TourDoneStep />;
  const View = STEP_VIEW[step];
  return <View key={step} />;
}
