/**
 * Copy for "Continue on <machine>". Plain English, no git vocabulary unless
 * the person has to act on it.
 */
import type { ContinueOnMachineStep } from "./continueOnMachine";

export const CONTINUE_ON_MACHINE_COPY = {
  action: "Continue on another machine…",
  actionShort: "Continue on…",
  title: "Continue this chat on another machine",
  description: (threadTitle: string) =>
    `"${threadTitle}" will open on the machine you pick, with the project files exactly as they are here (including unsaved work) and the recent history of this chat.`,
  targetLabel: "Where to continue",
  noTargets: "No other machines are connected yet. Add a box or another computer first.",
  connected: "Connected",
  copyEnv: "Copy .env secrets",
  copyEnvHint: "Sends the project's root .env to the other machine over your connection.",
  archiveSource: "Archive this chat here once it opens there",
  submit: "Continue there",
  submitting: "Continuing…",
  retry: "Try again",
  cancel: "Cancel",
  close: "Close",
  successTitle: (machineLabel: string) => `Now on ${machineLabel}`,
  successDescription: (input: {
    readonly projectCreated: boolean;
    readonly envWritten: boolean;
    readonly modelFallbackApplied: boolean;
  }): string => {
    const parts: string[] = ["The chat and files are there"];
    if (input.projectCreated) parts.push("the project was cloned onto that machine");
    if (input.envWritten) parts.push(".env copied");
    if (input.modelFallbackApplied)
      parts.push("it runs on a different model, see the first message");
    return `${parts.join(" · ")}.`;
  },
  failureTitle: "Could not continue on that machine",
  stepFailed: (step: ContinueOnMachineStep) => `Failed while ${STEP_PROGRESS_LABELS[step]}`,
  openingThreadTimedOut:
    "The chat was created but did not show up yet. Switch to that machine to find it.",
} as const;

/** Gerund phrases for progress and failure lines ("Failed while …"). */
export const STEP_PROGRESS_LABELS: Record<ContinueOnMachineStep, string> = {
  connecting: "connecting to the other machine",
  saving: "saving files and pushing them",
  preparing: "preparing the other machine",
  marking: "marking this chat as continued",
  opening: "opening the chat there",
};

/** Step labels for the checklist shown during the run. */
export const STEP_LABELS: Record<ContinueOnMachineStep, string> = {
  connecting: "Connecting",
  saving: "Saving files → Pushing",
  preparing: "Preparing the machine",
  marking: "Marking this chat",
  opening: "Opening",
};

export const STEP_LABEL_WITH_MACHINE = (
  step: ContinueOnMachineStep,
  machineLabel: string,
): string => (step === "preparing" ? `Preparing ${machineLabel}` : STEP_LABELS[step]);
