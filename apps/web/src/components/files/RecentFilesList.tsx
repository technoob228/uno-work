/**
 * Files → Recent: the files you opened in Uno Work and the files agents
 * changed in your chats, newest first (kept by the computer, so the same list
 * shows on every device — see FilesRecentService on the daemon). A click
 * opens the file on the right, like the tree.
 */
import type { EnvironmentId, FilesEntry, FilesRecentItem } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ClockIcon, SparklesIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { Skeleton } from "../ui/skeleton";
import { FILE_KIND_ICON, FILE_KIND_TINT, fileKindOf, formatModified } from "./fileTypes";
import { filesRecentQueryOptions } from "./filesApi";
import {
  filterRecent,
  groupRecentByDay,
  recentFolderLabel,
  recentSourceLabel,
  type RecentFilter,
} from "./filesRecent";

const FILTERS: ReadonlyArray<{ readonly id: RecentFilter; readonly label: string }> = [
  { id: "all", label: "All" },
  { id: "opened", label: "Opened" },
  { id: "agent", label: "By agents" },
];

export const RecentFilesList = memo(function RecentFilesList({
  environmentId,
  rootPath,
  selectedFile,
  onOpenFile,
}: {
  environmentId: EnvironmentId | null;
  rootPath: string | null;
  selectedFile: string | undefined;
  onOpenFile: (entry: FilesEntry) => void;
}) {
  const recent = useQuery(filesRecentQueryOptions(environmentId));
  const [filter, setFilter] = useState<RecentFilter>("all");
  const groups = useMemo(
    () => groupRecentByDay(filterRecent(recent.data?.items ?? [], filter)),
    [filter, recent.data],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="files-recent">
      <div className="flex shrink-0 items-center gap-1 px-2.5 pt-2 pb-1" role="tablist">
        {FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={filter === option.id}
            onClick={() => setFilter(option.id)}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-xs transition-colors",
              filter === option.id
                ? "bg-foreground/10 font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {recent.isPending ? (
          <div className="flex flex-col gap-2 px-1 pt-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-9 w-full rounded-md" />
            ))}
          </div>
        ) : recent.isError ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground/70">
            Recent files can't be loaded right now.
          </p>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
            <ClockIcon className="mb-1 size-6 text-muted-foreground/40" />
            <p className="text-sm font-medium">Nothing here yet</p>
            <p className="max-w-60 text-xs text-muted-foreground">
              {filter === "agent"
                ? "Files your agents change in chats show up here."
                : "Files you open, and files your agents change, show up here."}
            </p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="pt-2">
              <h3 className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground/80 uppercase">
                {group.label}
              </h3>
              <ul className="flex flex-col gap-px">
                {group.items.map((item) => (
                  <RecentRow
                    key={item.entry.path}
                    item={item}
                    rootPath={rootPath}
                    active={selectedFile === item.entry.path}
                    onOpen={onOpenFile}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
});

function RecentRow({
  item,
  rootPath,
  active,
  onOpen,
}: {
  item: FilesRecentItem;
  rootPath: string | null;
  active: boolean;
  onOpen: (entry: FilesEntry) => void;
}) {
  const kind = fileKindOf(item.entry.name);
  const Icon = FILE_KIND_ICON[kind];
  const byAgent = item.source === "agent";
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={() => onOpen(item.entry)}
        title={item.entry.path}
        data-testid="files-recent-row"
        className={cn(
          "flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
          active ? "bg-primary/10" : "hover:bg-accent/60",
        )}
      >
        <Icon className={cn("mt-0.5 size-4 shrink-0", FILE_KIND_TINT[kind])} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-sm", active && "font-medium")}>
              {item.entry.name}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {formatModified(item.at)}
            </span>
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {recentFolderLabel(rootPath, item.entry.path)}
          </span>
          <span
            className={cn(
              "flex min-w-0 items-center gap-1 text-[11px]",
              byAgent ? "text-primary/80" : "text-muted-foreground/80",
            )}
          >
            {byAgent ? <SparklesIcon className="size-3 shrink-0" /> : null}
            <span className="truncate">{recentSourceLabel(item)}</span>
          </span>
        </span>
      </button>
    </li>
  );
}
