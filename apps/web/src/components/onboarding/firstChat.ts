import { isAssistantProjectId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";

/**
 * The browser onboarding ends in a chat, not a settings screen. These are the
 * suggestions it offers for the first message. The label is what the chip
 * shows; the prompt is the message placed in the composer — visible and
 * editable before the user sends it, so it can be a little fuller than the
 * label without putting words in the user's mouth invisibly.
 */
export interface FirstChatSuggestion {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
}

export const FIRST_CHAT_SUGGESTIONS: ReadonlyArray<FirstChatSuggestion> = [
  {
    id: "tour",
    label: "Show me what you can do",
    prompt:
      "Show me what you can do on this computer. Pick two or three quick demonstrations, walk me through them, and suggest what we could build first.",
  },
  {
    id: "website",
    label: "Make me a simple website",
    prompt:
      "Make me a simple website — one clean page is enough — and run it so I can open it and see the result.",
  },
  {
    id: "files",
    label: "Sort the files I upload",
    prompt:
      "Set up a folder where I can drop files, and sort whatever I put there into subfolders by type. Tell me where to upload things.",
  },
  {
    id: "telegram",
    label: "Set up a Telegram bot",
    prompt:
      "Set up a Telegram bot on this computer and walk me through connecting it to my Telegram account, step by step.",
  },
];

/** Title/folder of the project auto-created when the machine has none yet. */
export const FIRST_CHAT_PROJECT_TITLE = "Home";
export const FIRST_CHAT_PROJECT_DIR = "home";

export interface FirstChatProjectCandidate {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
}

/**
 * The project the first chat should open in: the first real (non-assistant)
 * project already on the connected machine, or `null` when the machine is
 * empty and a starter project has to be created first.
 */
export function pickFirstChatProject<T extends FirstChatProjectCandidate>(
  projects: ReadonlyArray<T>,
  environmentId: EnvironmentId,
): T | null {
  return (
    projects.find(
      (project) => project.environmentId === environmentId && !isAssistantProjectId(project.id),
    ) ?? null
  );
}
