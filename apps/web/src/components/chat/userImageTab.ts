/**
 * A picture the person attached to a message, opened beside the chat (Misha
 * 16.10 21:15, p.7): its copy in ~/Uploads opens as a tab of the right panel,
 * so the chat stays where it is. A picture with no copy on the computer (an
 * older message) — or one the panel can't draw — keeps the full-screen viewer.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import type { ChatImageAttachment } from "../../types";
import { detectFileKind, type PreviewFile } from "../preview/PreviewPaneContext";

export function userImagePanelTab(
  image: Pick<ChatImageAttachment, "name" | "savedPath">,
  environmentId: EnvironmentId,
): PreviewFile | null {
  const path = image.savedPath;
  if (!path) return null;
  const kind = detectFileKind(path.split("/").pop() ?? path);
  if (kind !== "image" && kind !== "svg") return null;
  return { id: path, name: image.name, kind, content: "", path, environmentId };
}
