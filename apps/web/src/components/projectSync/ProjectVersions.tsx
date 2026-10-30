/**
 * Project settings → Versions: how the project was, by day, in the person's
 * words. "Go back" puts the whole project back; a file in a version comes
 * back on its own. What is there now is saved first, so going back can be
 * undone the same way. The version's id is Dev Mode's business.
 *
 * @module projectSync/ProjectVersions
 */
import type { ProjectSyncEntry, ProjectVersion } from "@t3tools/contracts";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, HistoryIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { useDevMode } from "../../devMode";
import { readEnvironmentApi } from "../../environmentApi";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ProjectSettingsTarget } from "./ProjectSettingsDialog";
import { groupVersions, versionLine, versionTime } from "./projectSync.logic";
import { projectFilesQueryKey, projectVersionsQueryKey } from "./useProjectSync";

const CHANGE_WORD = { added: "new", changed: "changed", removed: "deleted" } as const;

export function ProjectVersions(props: {
  target: ProjectSettingsTarget;
  onRestored: (entry: ProjectSyncEntry) => void;
}) {
  const { target } = props;
  const api = readEnvironmentApi(target.environmentId);
  const queryClient = useQueryClient();
  const devMode = useDevMode();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const queryKey = projectVersionsQueryKey(target.environmentId, target.projectId);
  const history = useInfiniteQuery({
    queryKey,
    enabled: open && !!api,
    retry: false,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api!.projectSync.history({ projectId: target.projectId, skip: pageParam }),
    getNextPageParam: (last, pages) =>
      last.more ? pages.reduce((count, page) => count + page.versions.length, 0) : undefined,
  });
  const versions = history.data?.pages.flatMap((page) => page.versions) ?? [];

  const bringBack = async (version: ProjectVersion, files?: ReadonlyArray<string>) => {
    if (!api) return;
    setWorking(files?.[0] ?? version.id);
    try {
      const entry = await api.projectSync.restore({
        projectId: target.projectId,
        version: version.id,
        ...(files ? { files } : {}),
      });
      props.onRestored(entry);
      setConfirming(null);
      toastManager.add({
        type: "success",
        title: files?.[0] ? `${files[0]} is back` : `Back to ${versionTime(version.at)}`,
        description: "What was there before stays in Versions.",
      });
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({
        queryKey: projectFilesQueryKey(target.environmentId, target.projectId),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't go back",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setWorking(null);
    }
  };

  return (
    <section className="space-y-2" data-testid="project-versions">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-2 text-sm font-medium text-foreground"
      >
        <HistoryIcon className="size-4 text-muted-foreground" />
        <span className="flex-1 text-left">Versions</span>
        <ChevronRightIcon
          className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")}
        />
      </button>
      {!open ? (
        <p className="text-xs text-muted-foreground">
          Saved as you work. Go back to how it was yesterday, or bring back one file.
        </p>
      ) : history.isError ? (
        <p className="text-xs text-muted-foreground">Couldn't load the versions.</p>
      ) : history.isPending ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : versions.length === 0 ? (
        <p className="text-xs text-muted-foreground">No versions yet.</p>
      ) : (
        <div className="max-h-72 space-y-3 overflow-y-auto">
          {groupVersions(versions).map((group) => (
            <div key={group.day} className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{group.day}</div>
              <ul className="divide-y divide-border rounded-md border border-border">
                {group.versions.map((version) => {
                  const newest = version.id === versions[0]?.id;
                  return (
                    <li key={version.id} className="text-xs" data-testid="project-version">
                      <div className="flex items-center gap-2 px-3 py-1.5">
                        <button
                          type="button"
                          aria-expanded={shown === version.id}
                          onClick={() =>
                            setShown((value) => (value === version.id ? null : version.id))
                          }
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                        >
                          <span className="shrink-0 text-muted-foreground tabular-nums">
                            {versionTime(version.at)}
                          </span>
                          <span className="min-w-0 truncate text-foreground">
                            {versionLine(version)}
                          </span>
                          {devMode ? (
                            <code className="shrink-0 font-mono text-muted-foreground">
                              {version.id.slice(0, 7)}
                            </code>
                          ) : null}
                        </button>
                        {newest ? (
                          <span className="shrink-0 text-muted-foreground">Now</span>
                        ) : (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={working !== null}
                            onClick={() => setConfirming(version.id)}
                          >
                            Go back
                          </Button>
                        )}
                      </div>
                      {confirming === version.id ? (
                        <div className="space-y-2 border-t border-border bg-muted/40 px-3 py-2">
                          <p className="text-foreground">
                            Put the whole project back as it was at {versionTime(version.at)}? What
                            is there now stays in Versions.
                          </p>
                          <div className="flex gap-2">
                            <Button
                              size="xs"
                              disabled={working !== null}
                              onClick={() => void bringBack(version)}
                            >
                              {working === version.id ? (
                                <RefreshCwIcon className="animate-spin" />
                              ) : null}
                              Go back
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={working !== null}
                              onClick={() => setConfirming(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : null}
                      {shown === version.id ? (
                        <ul className="border-t border-border px-3 py-1">
                          {version.files.map((file) => (
                            <li key={file.path} className="flex items-center gap-2 py-0.5">
                              <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                                {file.path}
                              </span>
                              <span className="shrink-0 text-muted-foreground">
                                {CHANGE_WORD[file.change]}
                              </span>
                              {file.change === "removed" ? null : (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  disabled={working !== null}
                                  onClick={() => void bringBack(version, [file.path])}
                                >
                                  Bring back
                                </Button>
                              )}
                            </li>
                          ))}
                          {version.moreFiles > 0 ? (
                            <li className="py-0.5 text-muted-foreground">
                              and {version.moreFiles} more
                            </li>
                          ) : null}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {history.hasNextPage ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              Show older
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
