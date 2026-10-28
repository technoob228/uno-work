/**
 * Loom Work on Home: "Show the agent" next to "Add a project". The recording
 * lives under Home's own key until the person sends; then it moves to the new
 * chat Home starts, and that chat sends it like any recording made there.
 */
import { type RecordingItem, recordingReadiness } from "./pipeline";
import { prefilledInstruction } from "./recordingLogic";

/** The store key of Home's recording on one computer. */
export function homeRecordingKey(environmentId: string): string {
  return `home:${environmentId}`;
}

/**
 * Once the agent has watched it, the person's words go into Home's box —
 * once, and only into an empty box. `text` = what goes in (null = leave it).
 */
export function homeRecordingPrefill(
  item: RecordingItem | null,
  currentText: string,
): { readonly mark: boolean; readonly text: string | null } {
  if (!item || item.prefilled) return { mark: false, text: null };
  if (item.watch.status !== "done" && item.watch.status !== "skipped") {
    return { mark: false, text: null };
  }
  return {
    mark: true,
    text: currentText.trim().length === 0 ? prefilledInstruction(item.watch.speech) : null,
  };
}

/** Can Home start the chat now: nothing to send, wait for the recording, or go. */
export function homeSendCheck(input: {
  readonly text: string;
  readonly attachments: number;
  readonly recording: RecordingItem | null;
}):
  | { readonly kind: "empty" }
  | { readonly kind: "blocked"; readonly message: string }
  | { readonly kind: "send" } {
  if (input.text.trim().length === 0 && input.attachments === 0 && !input.recording) {
    return { kind: "empty" };
  }
  if (input.recording) {
    const readiness = recordingReadiness(input.recording);
    if (!readiness.ready) {
      return { kind: "blocked", message: readiness.blocking ?? "Wait for the recording." };
    }
  }
  return { kind: "send" };
}
