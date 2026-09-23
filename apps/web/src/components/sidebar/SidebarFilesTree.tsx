/**
 * Files mode of the sidebar: the computer's home folder as a tree, like the
 * sidebar of Finder. Folders unfold in place (each level is listed on
 * demand); a click on a name opens it in Files — a folder to browse, a file in
 * its viewer. Every row can be pinned.
 */
import type { FilesEntry } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  FileIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  HouseIcon,
  PinIcon,
  PinOffIcon,
  PresentationIcon,
} from "lucide-react";
import { memo, useState } from "react";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { cn } from "../../lib/utils";
import { pathTitle } from "../../navigation/pins";
import { usePins } from "../../navigation/usePins";
import { filesListQueryOptions } from "../files/filesApi";
import { dirname } from "../files/fileTypes";
import { useSidebar } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";

const MAX_ENTRIES_PER_FOLDER = 200;

function fileIconFor(name: string) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (["xlsx", "xls", "csv", "ods"].includes(ext)) return FileSpreadsheetIcon;
  if (["pptx", "ppt", "odp", "key"].includes(ext)) return PresentationIcon;
  if (["docx", "doc", "odt", "md", "txt", "pdf", "rtf"].includes(ext)) return FileTextIcon;
  return FileIcon;
}

function sortEntries(entries: ReadonlyArray<FilesEntry>): FilesEntry[] {
  return entries.toSorted((a, b) => {
    const aDir = a.kind === "directory" ? 0 : 1;
    const bDir = b.kind === "directory" ? 0 : 1;
    return aDir - bDir || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export const SidebarFilesTree = memo(function SidebarFilesTree() {
  const { environmentId } = useActiveMachine();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const root = useQuery(filesListQueryOptions(environmentId, null, false));
  const onFilesPage = useLocation({ select: (location) => location.pathname === "/files" });

  if (root.isPending) {
    return (
      <div className="flex flex-col gap-1.5 px-2 pt-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-5 w-full rounded-md" />
        ))}
      </div>
    );
  }
  if (root.isError || !root.data) {
    return (
      <p className="px-2 py-6 text-center text-xs text-muted-foreground/70">
        This computer's files can't be read right now.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-px">
      <button
        type="button"
        onClick={() => {
          if (isMobile) setOpenMobile(false);
          void navigate({ to: "/files" });
        }}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-left text-sm outline-hidden ring-ring transition-colors focus-visible:ring-2",
          onFilesPage
            ? "text-foreground"
            : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover hover:text-foreground",
        )}
      >
        <HouseIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">Home folder</span>
      </button>
      <TreeLevel entries={root.data.entries} depth={0} />
    </div>
  );
});

function TreeLevel({ entries, depth }: { entries: ReadonlyArray<FilesEntry>; depth: number }) {
  const sorted = sortEntries(entries.filter((entry) => !entry.hidden));
  if (sorted.length === 0) {
    return (
      <p
        className="py-1 text-[11px] text-muted-foreground/60"
        style={{ paddingLeft: `${depth * 12 + 30}px` }}
      >
        Empty
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-px">
      {sorted.slice(0, MAX_ENTRIES_PER_FOLDER).map((entry) => (
        <TreeRow key={entry.path} entry={entry} depth={depth} />
      ))}
      {sorted.length > MAX_ENTRIES_PER_FOLDER ? (
        <li
          className="list-none py-1 text-[11px] text-muted-foreground/60"
          style={{ paddingLeft: `${depth * 12 + 30}px` }}
        >
          {sorted.length - MAX_ENTRIES_PER_FOLDER} more — open the folder in Files
        </li>
      ) : null}
    </ul>
  );
}

function TreeRow({ entry, depth }: { entry: FilesEntry; depth: number }) {
  const isFolder = entry.kind === "directory";
  const [expanded, setExpanded] = useState(false);
  const { environmentId } = useActiveMachine();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const { isPinned, toggle } = usePins();
  const children = useQuery({
    ...filesListQueryOptions(environmentId, entry.path, false),
    enabled: environmentId !== null && isFolder && expanded,
  });
  const search = useLocation({ select: (location) => location.search as Record<string, unknown> });
  const active = isFolder
    ? search["path"] === entry.path && !search["file"]
    : search["file"] === entry.path;
  const pinKind = isFolder ? "folder" : "file";
  const pinned = isPinned(pinKind, entry.path);

  const open = () => {
    if (isMobile) setOpenMobile(false);
    if (isFolder) {
      setExpanded(true);
      void navigate({ to: "/files", search: { path: entry.path } });
    } else {
      void navigate({ to: "/files", search: { path: dirname(entry.path), file: entry.path } });
    }
  };

  const Icon = isFolder ? (expanded ? FolderOpenIcon : FolderIcon) : fileIconFor(entry.name);

  return (
    <li className="list-none">
      <div
        className={cn(
          "group/row relative flex h-7 items-center rounded-md pr-7 text-sm transition-colors",
          active
            ? "bg-sidebar-row-active text-foreground"
            : "text-sidebar-foreground/90 hover:bg-sidebar-row-hover hover:text-foreground",
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {isFolder ? (
          <button
            type="button"
            aria-label={expanded ? `Collapse ${entry.name}` : `Expand ${entry.name}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/70 hover:text-foreground"
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="size-5 shrink-0" />
        )}
        <button
          type="button"
          onClick={open}
          title={entry.path}
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left outline-hidden focus-visible:underline"
        >
          <Icon
            className={cn(
              "size-4 shrink-0",
              isFolder ? "text-primary/80" : "text-muted-foreground",
            )}
          />
          <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        </button>
        <button
          type="button"
          aria-label={pinned ? `Unpin ${entry.name}` : `Pin ${entry.name}`}
          title={pinned ? "Unpin" : "Pin to the sidebar"}
          onClick={() =>
            toggle({ kind: pinKind, title: pathTitle(entry.path), target: entry.path })
          }
          className={cn(
            "absolute top-1/2 right-1 inline-flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground",
            pinned
              ? "text-primary opacity-100"
              : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
          )}
        >
          {pinned ? <PinOffIcon className="size-3" /> : <PinIcon className="size-3" />}
        </button>
      </div>
      {isFolder && expanded ? (
        children.isPending ? (
          <div className="py-1" style={{ paddingLeft: `${(depth + 1) * 12 + 30}px` }}>
            <Skeleton className="h-4 w-24 rounded" />
          </div>
        ) : children.data ? (
          <TreeLevel entries={children.data.entries} depth={depth + 1} />
        ) : null
      ) : null}
    </li>
  );
}
