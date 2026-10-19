/**
 * The body of the panel's Files tab (filesPanelTab.ts): Files itself, its
 * place kept per tab, laid out for the panel's column — or as on its own
 * screen while the panel has the whole window.
 */
import { useCallback } from "react";

import { usePreviewPane, type PreviewFile } from "../preview/PreviewPaneContext";
import { FilesBrowser } from "./FilesView";
import { usePanelFilesPlace, usePanelFilesStore } from "./filesPanelTab";
import type { FilesRouteSearch } from "./filesRouteSearch";

export function PanelFilesTab({ file }: { file: PreviewFile }) {
  const { previewLayoutMode, currentChatEnvironmentId } = usePreviewPane();
  const place = usePanelFilesPlace(file.id);
  const setPlace = usePanelFilesStore((state) => state.setPlace);
  const setSearch = useCallback(
    (next: FilesRouteSearch) => setPlace(file.id, next),
    [file.id, setPlace],
  );
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="panel-files-tab">
      <FilesBrowser
        search={place}
        setSearch={setSearch}
        panel={{
          environmentId: file.environmentId ?? currentChatEnvironmentId,
          wide: previewLayoutMode === "focus",
        }}
      />
    </div>
  );
}
