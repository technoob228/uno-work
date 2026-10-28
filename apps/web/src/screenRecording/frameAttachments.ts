/**
 * A recording's key frames as the message's pictures (Loom Work 28.10): named
 * by their moment (`recording-frame 0m12.4s click.jpg`) so the chat can show
 * them inside the recording card and the agent reads the legend in order.
 */
import { keyFrameName } from "./agentView";
import type { RecordingItem } from "./pipeline";

export interface RecordingFrameAttachment {
  readonly id: string;
  readonly name: string;
  readonly blob: File;
  readonly previewUrl: string;
}

export function recordingFrameAttachments(
  item: Pick<RecordingItem, "id" | "watch">,
  createUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
): RecordingFrameAttachment[] {
  if (item.watch.status !== "done") return [];
  return item.watch.frames.map((frame, index) => {
    const name = keyFrameName(frame);
    const file = new File([frame.blob], name, { type: "image/jpeg" });
    return { id: `${item.id}-frame-${index + 1}`, name, blob: file, previewUrl: createUrl(file) };
  });
}
