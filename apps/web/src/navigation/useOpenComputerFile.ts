/**
 * Where a file of the computer opens when the person picks it outside the
 * Files screen (the sidebar's Files tree, a pin):
 *
 *   - in a chat → the right panel, beside the chat, so the chat stays put
 *     (Misha 13.10 / 14.10). The panel's "Open full screen" moves it to Files;
 *   - anywhere else, or a file the panel can't show (pptx, archives, …) →
 *     Files, with the file open on the right of the tree.
 *
 * Word and Excel files open in the panel too: it has viewers for them, and
 * "Open full screen" leads to Files → "Edit in Office" for editing.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useMatch, useNavigate } from "@tanstack/react-router";
import { useCallback, useRef } from "react";

import { basename, dirname } from "../components/files/fileTypes";
import {
  detectFileKind,
  usePreviewPane,
  type PreviewFile,
  type PreviewFileKind,
} from "../components/preview/PreviewPaneContext";
import { useActiveMachine } from "../hooks/useActiveMachine";

export type ComputerFileTarget = "beside" | "files";

export function computerFileTarget(input: {
  readonly inChat: boolean;
  readonly previewKind: PreviewFileKind;
  readonly hasEnvironment: boolean;
}): ComputerFileTarget {
  return input.inChat && input.hasEnvironment && input.previewKind !== "unknown"
    ? "beside"
    : "files";
}

/** The right-panel tab for a file of the computer (its id is the path: opening twice focuses it). */
export function computerFileTab(path: string, environmentId: EnvironmentId): PreviewFile {
  const name = basename(path) || path;
  return { id: path, name, kind: detectFileKind(name), content: "", path, environmentId };
}

/**
 * Opens a file of the computer (see the module comment). The returned
 * function is stable, so long lists (the sidebar tree) can pass it down to
 * memoized rows without re-rendering on every panel change.
 */
export function useOpenComputerFile(): (path: string) => void {
  const navigate = useNavigate();
  const preview = usePreviewPane();
  const { environmentId } = useActiveMachine();
  const inChat = useMatch({ from: "/_chat/$environmentId/$threadId", shouldThrow: false });
  const latest = useRef({ navigate, openFile: preview.openFile, environmentId, inChat });
  latest.current = { navigate, openFile: preview.openFile, environmentId, inChat };
  return useCallback((path: string) => {
    const current = latest.current;
    const target = computerFileTarget({
      inChat: Boolean(current.inChat),
      previewKind: detectFileKind(basename(path)),
      hasEnvironment: current.environmentId !== null,
    });
    if (target === "beside" && current.environmentId) {
      current.openFile(computerFileTab(path, current.environmentId));
      return;
    }
    void current.navigate({ to: "/files", search: { path: dirname(path), file: path } });
  }, []);
}
