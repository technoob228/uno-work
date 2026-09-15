/**
 * Copy for "Continue on <machine>". Plain English, no git vocabulary unless
 * the person has to act on it.
 */
import type { ContinueOnMachineStep, ContinueTargetState } from "./continueOnMachine";

export const CONTINUE_ON_MACHINE_COPY = {
  action: "Continue on another machine…",
  actionShort: "Continue on…",
  title: "Continue this chat on another machine",
  description: (threadTitle: string) =>
    `"${threadTitle}" will open on the machine you pick, with the project files exactly as they are here (including unsaved work) and the recent history of this chat. The files go straight to that machine over your connection, not through GitHub.`,
  targetLabel: "Where to continue",
  noTargets: "No other machines are connected yet. Add a box or another computer first.",
  connected: "Connected",
  hasProject: "Has this project",
  willAddProject: "Project will be added",
  needsUpdate: "Needs update",
  copyEnv: "Also copy .env secrets",
  copyEnvHint:
    "Off by default. When on, the project's .env is sent to the other machine over your connection and saved in the chat's new folder there.",
  archiveSource: "Archive this chat here once it opens there",
  submit: "Continue there",
  submitting: "Continuing…",
  retry: "Try again",
  cancel: "Cancel",
  close: "Close",
  updateRequired: (machineLabel: string) =>
    `Update Uno Work on ${machineLabel} to continue chats there. The new version sends files directly between your machines instead of through GitHub.`,
  successTitle: (machineLabel: string) => `Now on ${machineLabel}`,
  successDescription: (input: {
    readonly branch: string;
    readonly projectCreated: boolean;
    readonly envWritten: boolean;
    readonly modelFallbackApplied: boolean;
  }): string => {
    const parts: string[] = [`The chat and files are there, on a new branch ${input.branch}`];
    if (input.projectCreated) parts.push("the project was added to that machine");
    if (input.envWritten) parts.push(".env copied");
    if (input.modelFallbackApplied)
      parts.push("it runs on a different model, see the first message");
    return `${parts.join(" · ")}.`;
  },
  failureTitle: "Could not continue on that machine",
  stepFailed: (step: ContinueOnMachineStep) => `Failed while ${STEP_PROGRESS_LABELS[step]}`,
  openingThreadTimedOut:
    "The chat was created but did not show up yet. Switch to that machine to find it.",
  /** Lines shown under the machine list once the target has been inspected. */
  inspecting: (machineLabel: string) => `Checking the project on ${machineLabel}…`,
  inspectFailed: (machineLabel: string) => `Could not check the project on ${machineLabel}`,
  inspectRetry: "Check again",
  targetState: (state: ContinueTargetState, machineLabel: string): string => {
    switch (state.kind) {
      case "missing":
        return `The project is not on ${machineLabel} yet. It will be added at ${state.destinationPath}.`;
      case "not-git":
        return `${state.projectPath} already exists on ${machineLabel} and is not a git repository. Remove it or pick another folder.`;
      case "exists":
        return `The chat opens in a separate copy of the project on a new branch. Your files in ${state.projectPath} on ${machineLabel} stay as they are.`;
    }
  },
  sendingProgress: (sentBytes: number, totalBytes: number) =>
    `${formatBytes(sentBytes)} of ${formatBytes(totalBytes)}`,
  /** Collapsed seed card in the chat timeline. */
  seedCardTitle: (sourceMachineLabel: string | null) =>
    sourceMachineLabel ? `Continued from ${sourceMachineLabel}` : "Continued from an earlier chat",
  seedCardCount: (earlierMessages: number) =>
    `${earlierMessages} earlier ${earlierMessages === 1 ? "message" : "messages"}`,
  seedShowHistory: "Show history",
  seedHideHistory: "Hide history",
} as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Gerund phrases for progress and failure lines ("Failed while …"). */
export const STEP_PROGRESS_LABELS: Record<ContinueOnMachineStep, string> = {
  connecting: "connecting to the other machine",
  saving: "saving the files",
  sending: "sending the files",
  preparing: "preparing the other machine",
  marking: "marking this chat as continued",
  opening: "opening the chat there",
};

/** Step labels for the checklist shown during the run. */
export const STEP_LABELS: Record<ContinueOnMachineStep, string> = {
  connecting: "Connecting",
  saving: "Saving files",
  sending: "Sending files",
  preparing: "Preparing the machine",
  marking: "Marking this chat",
  opening: "Opening",
};

export const STEP_LABEL_WITH_MACHINE = (
  step: ContinueOnMachineStep,
  machineLabel: string,
): string => {
  if (step === "preparing") return `Preparing ${machineLabel}`;
  if (step === "sending") return `Sending files to ${machineLabel}`;
  return STEP_LABELS[step];
};
