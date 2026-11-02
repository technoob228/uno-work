/**
 * A pull request's changes inside Work: the files as a tree with a filter, the
 * diffs beside them, Viewed marks that live on the host. Search looks through
 * file names and the changed lines.
 */
import type {
  PullRequestDetailView,
  PullRequestDiffFile,
  PullRequestRef,
} from "@t3tools/contracts";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon, FileIcon, FolderIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { buildPatchCacheKey, resolveDiffThemeName } from "../../lib/diffRendering";
import { cn } from "../../lib/utils";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import {
  filesMatchingSearch,
  fileTree,
  patchTextByFile,
  type PullRequestFileTreeNode,
} from "./pullRequestFiles.logic";
import { pullRequestDiffQuery, useSetFileViewed } from "./pullRequestQueries";

function TreeRows(props: {
  readonly nodes: ReadonlyArray<PullRequestFileTreeNode>;
  readonly depth: number;
  readonly selected: string | null;
  readonly onSelect: (path: string) => void;
}) {
  const { nodes, depth, selected, onSelect } = props;
  return nodes.map((node) =>
    node.kind === "directory" ? (
      <div key={node.path}>
        <div
          className="flex items-center gap-1 truncate py-0.5 text-xs text-muted-foreground"
          style={{ paddingLeft: depth * 12 + 4 }}
        >
          <FolderIcon className="size-3 shrink-0" />
          <span className="truncate">{node.name}</span>
        </div>
        <TreeRows nodes={node.children} depth={depth + 1} selected={selected} onSelect={onSelect} />
      </div>
    ) : (
      <button
        type="button"
        key={node.path}
        onClick={() => onSelect(node.path)}
        title={node.path}
        data-testid="pull-request-tree-file"
        className={cn(
          "flex w-full items-center gap-1 rounded-sm py-0.5 pr-1 text-left text-xs hover:bg-accent",
          selected === node.path && "bg-accent",
          node.file.viewed === "viewed" && "text-muted-foreground",
        )}
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        <FileIcon className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        {node.file.viewed === "changed" ? (
          <span className="shrink-0 text-[10px] text-amber-600">Changed</span>
        ) : null}
      </button>
    ),
  );
}

function FileBlock(props: {
  readonly file: PullRequestDiffFile;
  readonly diff: FileDiffMetadata | undefined;
  readonly viewedShown: boolean;
  readonly onViewed: (viewed: boolean) => void;
  readonly busy: boolean;
}) {
  const { file, diff, viewedShown, onViewed, busy } = props;
  const { resolvedTheme } = useTheme();
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? file.viewed !== "viewed";
  return (
    <section data-testid="pull-request-file" data-path={file.path} id={fileAnchor(file.path)}>
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background py-1.5 text-xs">
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          aria-expanded={expanded}
          onClick={() => setOpen(!expanded)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          <ChevronRightIcon className={cn("size-3.5 shrink-0", expanded && "rotate-90")} />
          <span className="truncate font-mono">{file.path}</span>
        </button>
        <span className="shrink-0 tabular-nums text-emerald-600">+{file.additions}</span>
        <span className="shrink-0 tabular-nums text-red-600">-{file.deletions}</span>
        {viewedShown ? (
          <label className="flex shrink-0 items-center gap-1 text-muted-foreground">
            <Checkbox
              checked={file.viewed === "viewed"}
              disabled={busy}
              onCheckedChange={(checked) => {
                onViewed(Boolean(checked));
                setOpen(!checked);
              }}
              data-testid="pull-request-viewed"
            />
            Viewed
          </label>
        ) : null}
      </header>
      {expanded ? (
        diff ? (
          <FileDiff
            fileDiff={diff}
            options={{
              diffStyle: "unified",
              lineDiffType: "none",
              overflow: "scroll",
              disableFileHeader: true,
              theme: resolveDiffThemeName(resolvedTheme),
              themeType: resolvedTheme,
            }}
          />
        ) : (
          <p className="py-3 text-xs text-muted-foreground">No text changes here.</p>
        )
      ) : null}
    </section>
  );
}

const fileAnchor = (path: string) => `pr-file-${encodeURIComponent(path)}`;

export function PullRequestFilesTab(props: {
  readonly environmentId: string;
  readonly detail: PullRequestDetailView;
  readonly commit: string | null;
  readonly onClearCommit: () => void;
}) {
  const { environmentId, detail, commit, onClearCommit } = props;
  const ref: PullRequestRef = useMemo(
    () => ({
      projectId: detail.projectId,
      repository: detail.repository,
      number: detail.number,
    }),
    [detail.projectId, detail.repository, detail.number],
  );
  const query = useQuery(
    pullRequestDiffQuery(environmentId, { ...ref, ...(commit !== null ? { commit } : {}) }),
  );
  const setViewed = useSetFileViewed(environmentId, ref);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const patch = query.data?.diff ?? "";
  const diffs = useMemo(() => {
    const byPath = new Map<string, FileDiffMetadata>();
    if (patch.trim().length === 0) return byPath;
    try {
      for (const parsed of parsePatchFiles(patch, buildPatchCacheKey(patch, "pull-request"))) {
        for (const file of parsed.files) byPath.set(file.name, file);
      }
    } catch {
      // Unparsable: the blocks below say there are no text changes, the link remains.
    }
    return byPath;
  }, [patch]);
  const textByFile = useMemo(() => patchTextByFile(patch), [patch]);
  const inCommit = useMemo(
    () => (query.data?.files ?? []).filter((file) => commit === null || diffs.has(file.path)),
    [query.data?.files, commit, diffs],
  );
  const shown = useMemo(
    () => filesMatchingSearch(inCommit, textByFile, search),
    [inCommit, textByFile, search],
  );
  const tree = useMemo(() => fileTree(shown), [shown]);

  if (query.isLoading) return <Skeleton className="h-40 w-full" />;
  if (query.error) {
    return <p className="text-sm text-muted-foreground">{query.error.message}</p>;
  }
  if (query.data?.truncated) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="pull-request-diff-too-large">
        Too large to show here.{" "}
        <a className="underline" href={detail.url} target="_blank" rel="noreferrer noopener">
          Open on the site
        </a>
      </p>
    );
  }
  const viewedCount = inCommit.filter((file) => file.viewed === "viewed").length;
  const select = (path: string) => {
    setSelected(path);
    document.getElementById(fileAnchor(path))?.scrollIntoView({ block: "start" });
  };

  return (
    <DiffWorkerPoolProvider>
      <div className="flex min-h-0 flex-1 gap-3">
        <aside className="hidden w-56 shrink-0 flex-col gap-2 overflow-y-auto md:flex">
          <label className="relative block">
            <SearchIcon className="absolute top-1.5 left-2 size-3.5 text-muted-foreground" />
            <Input
              size="sm"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search changes"
              aria-label="Search changes"
              className="pl-6"
              data-testid="pull-request-diff-search"
            />
          </label>
          {detail.capabilities.viewedFiles && commit === null ? (
            <p className="text-[11px] text-muted-foreground" data-testid="pull-request-viewed-count">
              {viewedCount} of {inCommit.length} viewed
            </p>
          ) : null}
          <div>
            <TreeRows nodes={tree} depth={0} selected={selected} onSelect={select} />
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
          {commit !== null ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              Commit <span className="font-mono">{commit.slice(0, 7)}</span>
              <Button size="xs" variant="ghost" onClick={onClearCommit}>
                All changes
              </Button>
            </p>
          ) : null}
          {shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing matches.</p>
          ) : null}
          {shown.map((file) => (
            <FileBlock
              key={file.path}
              file={file}
              diff={diffs.get(file.path)}
              viewedShown={detail.capabilities.viewedFiles}
              busy={setViewed.isPending}
              onViewed={(viewed) => setViewed.mutate({ path: file.path, viewed })}
            />
          ))}
        </div>
      </div>
    </DiffWorkerPoolProvider>
  );
}
