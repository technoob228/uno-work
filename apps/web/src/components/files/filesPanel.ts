/**
 * Files next to the right panel (Misha 16.10 21:15, p.6). While the panel is
 * on screen, the middle column of Files is redundant: a file picked in Files
 * opens as one more tab of the panel, in the Everywhere group, and the middle
 * column only shows a file the panel can't show (or one sent to Files on
 * purpose — the panel's "Open full screen"). With the panel closed, Files
 * works as before.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import type { PreviewFile, PreviewFileKind } from "../preview/PreviewPaneContext";

/** The right panel is on screen beside Files (mirrors PreviewPane's `paneVisible`). */
export function filesPanelBeside(input: {
  readonly isMobile: boolean;
  readonly panelOpen: boolean;
  readonly panelTabCount: number;
  readonly inChat: boolean;
}): boolean {
  // A phone has no room for Files and the panel side by side.
  if (input.isMobile) return false;
  return input.panelOpen && (input.panelTabCount > 0 || input.inChat);
}

export type FilesOpenTarget = "panel" | "files";

/** Where a file picked in Files opens: as a panel tab, or in Files itself. */
export function filesOpenTarget(input: {
  readonly panelBeside: boolean;
  readonly previewKind: PreviewFileKind;
  readonly hasEnvironment: boolean;
}): FilesOpenTarget {
  return input.panelBeside && input.hasEnvironment && input.previewKind !== "unknown"
    ? "panel"
    : "files";
}

/** The path of this computer's file in the panel's active tab — the tree marks it. */
export function activePanelFilePath(
  files: ReadonlyArray<Pick<PreviewFile, "id" | "path" | "environmentId">>,
  activeFileId: string | null,
  environmentId: EnvironmentId | null,
): string | undefined {
  const active = files.find((file) => file.id === activeFileId) ?? files[0];
  if (!active?.path?.startsWith("/") || !environmentId) return undefined;
  return active.environmentId === environmentId ? active.path : undefined;
}
