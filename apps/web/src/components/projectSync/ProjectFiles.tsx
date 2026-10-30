/**
 * Project settings → Files: the three kinds of files of a project. What
 * travels, what stays only on this computer (the person can add to it), and
 * keys, which never travel in files.
 *
 * @module projectSync/ProjectFiles
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, FolderSyncIcon } from "lucide-react";
import { useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import type { ProjectSettingsTarget } from "./ProjectSettingsDialog";
import { fileCount } from "./projectSync.logic";
import { projectFilesQueryKey } from "./useProjectSync";

export function ProjectFiles(props: { target: ProjectSettingsTarget; keyCount: number }) {
  const { target } = props;
  const api = readEnvironmentApi(target.environmentId);
  const queryClient = useQueryClient();
  const queryKey = projectFilesQueryKey(target.environmentId, target.projectId);
  const files = useQuery({
    queryKey,
    enabled: !!api,
    retry: false,
    queryFn: () => api!.projectSync.files({ projectId: target.projectId }),
  });
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const [working, setWorking] = useState(false);

  const choose = async (next: string, localOnly: boolean) => {
    if (!api) return;
    setWorking(true);
    try {
      queryClient.setQueryData(
        queryKey,
        await api.projectSync.setLocalOnly({ projectId: target.projectId, path: next, localOnly }),
      );
      setPath("");
      setOpen(true);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: localOnly ? "Couldn't keep it here" : "Couldn't let it travel",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setWorking(false);
    }
  };

  const data = files.data;
  const localCount = (data?.localOnly.length ?? 0) + (data?.more ?? 0);
  const keyCount = props.keyCount + (data?.keyFiles.length ?? 0);

  return (
    <section className="space-y-2" data-testid="project-files">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <FolderSyncIcon className="size-4 text-muted-foreground" />
        Files
      </div>
      {files.isError ? (
        <p className="text-xs text-muted-foreground">Couldn't read the folder.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border text-xs">
          <li className="flex items-center gap-2 px-3 py-1.5" data-testid="project-files-synced">
            <span className="flex-1 text-foreground">On all your computers</span>
            <span className="text-muted-foreground">{data ? fileCount(data.synced) : "…"}</span>
          </li>
          <li data-testid="project-files-local">
            <button
              type="button"
              aria-expanded={open}
              disabled={localCount === 0}
              onClick={() => setOpen((value) => !value)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left enabled:cursor-pointer"
            >
              <span className="flex-1 text-foreground">Only on this computer</span>
              <span className="text-muted-foreground">{data ? localCount : "…"}</span>
              {localCount > 0 ? (
                <ChevronRightIcon
                  className={cn(
                    "size-3.5 text-muted-foreground transition-transform",
                    open && "rotate-90",
                  )}
                />
              ) : null}
            </button>
            {open && data ? (
              <ul className="max-h-40 overflow-y-auto border-t border-border px-3 py-1">
                {data.localOnly.map((entry) => (
                  <li key={entry.path} className="flex items-center gap-2 py-0.5">
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                      {entry.path}
                    </span>
                    {entry.yours ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={working}
                        onClick={() => void choose(entry.path, false)}
                      >
                        Sync it
                      </Button>
                    ) : (
                      <span className="shrink-0 text-muted-foreground">automatic</span>
                    )}
                  </li>
                ))}
                {data.more > 0 ? (
                  <li className="py-0.5 text-muted-foreground">and {data.more} more</li>
                ) : null}
              </ul>
            ) : null}
          </li>
          <li className="flex items-center gap-2 px-3 py-1.5" data-testid="project-files-keys">
            <span className="flex-1 text-foreground">Keys</span>
            <span className="text-muted-foreground">{data ? keyCount : "…"}</span>
          </li>
        </ul>
      )}
      {data?.mode === "snapshot" ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim()) void choose(path.trim(), true);
          }}
        >
          <Input
            aria-label="File or folder to keep only on this computer"
            placeholder="videos/ or notes.md"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            className="min-w-0 flex-1 font-mono"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={!path.trim() || working}
            title="It stays here and leaves your other computers."
          >
            Keep only here
          </Button>
        </form>
      ) : null}
    </section>
  );
}
