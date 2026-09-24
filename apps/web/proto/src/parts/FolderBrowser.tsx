/**
 * Click-through folder picker, fenced to the home folder: breadcrumbs start
 * at "Home folder" and cannot go above it, hidden folders are not shown,
 * nothing is typed except a new folder's name. Used by A1's dialog, A2's
 * chip popover and A3's wizard.
 */
import { ChevronRightIcon, CodeIcon, FolderIcon, FolderPlusIcon, HouseIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { HOME_TREE, type Folder } from "../data";

function findFolder(path: ReadonlyArray<string>, extra: Record<string, string[]>): Folder {
  let node: Folder = HOME_TREE;
  for (const part of path) {
    const next: Folder | undefined = node.children?.find((c) => c.name === part);
    if (!next) return { name: part, children: (extra[path.join("/")] ?? []).map((n) => ({ name: n })) };
    node = next;
  }
  const key = path.join("/");
  const added = (extra[key] ?? []).map((n) => ({ name: n }));
  return { ...node, children: [...(node.children ?? []), ...added] };
}

export function toPath(parts: ReadonlyArray<string>): string {
  return parts.length === 0 ? "~" : `~/${parts.join("/")}`;
}

export function FolderBrowser({
  onPick,
  pickLabel = "Use this folder",
  compact,
  initial = [],
}: {
  onPick: (path: string, name: string, looksLikeCode: boolean) => void;
  pickLabel?: string;
  compact?: boolean;
  initial?: ReadonlyArray<string>;
}) {
  const [path, setPath] = useState<ReadonlyArray<string>>(initial);
  const [extra, setExtra] = useState<Record<string, string[]>>({});
  const [naming, setNaming] = useState<string | null>(null);
  const folder = findFolder(path, extra);
  const children = folder.children ?? [];
  const name = path.length === 0 ? "Home folder" : path[path.length - 1]!;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-0.5 px-1 pb-2 text-xs">
        <button
          type="button"
          onClick={() => setPath([])}
          className={cn("flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent", path.length === 0 && "font-medium text-foreground")}
        >
          <HouseIcon className="size-3" /> Home folder
        </button>
        {path.map((part, i) => (
          <span key={`${part}-${i}`} className="flex items-center gap-0.5">
            <ChevronRightIcon className="size-3 text-muted-foreground/60" />
            <button
              type="button"
              onClick={() => setPath(path.slice(0, i + 1))}
              className={cn("rounded px-1.5 py-0.5 hover:bg-accent", i === path.length - 1 && "font-medium text-foreground")}
            >
              {part}
            </button>
          </span>
        ))}
      </div>
      <ul className={cn("flex flex-col gap-px overflow-y-auto rounded-lg border bg-background p-1", compact ? "max-h-52" : "h-64")}>
        {children.length === 0 && naming === null ? (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">Empty folder</li>
        ) : null}
        {children.map((c) => (
          <li key={c.name}>
            <button
              type="button"
              onClick={() => setPath([...path, c.name])}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent"
            >
              <FolderIcon className="size-4 shrink-0 text-sky-500" />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              {c.code ? (
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <CodeIcon className="size-3" /> code
                </span>
              ) : null}
              {c.children?.length ? <ChevronRightIcon className="size-3.5 text-muted-foreground" /> : null}
            </button>
          </li>
        ))}
        {naming !== null ? (
          <li className="flex items-center gap-2 px-2 py-1">
            <FolderIcon className="size-4 shrink-0 text-sky-500" />
            <input
              autoFocus
              value={naming}
              onChange={(e) => setNaming(e.target.value.replace(/[/\\]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && naming.trim()) {
                  const key = path.join("/");
                  setExtra({ ...extra, [key]: [...(extra[key] ?? []), naming.trim()] });
                  setPath([...path, naming.trim()]);
                  setNaming(null);
                }
                if (e.key === "Escape") setNaming(null);
              }}
              placeholder="Folder name, then Enter"
              className="h-7 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </li>
        ) : null}
      </ul>
      <div className="flex items-center gap-2 pt-2">
        <Button size="xs" variant="ghost" onClick={() => setNaming("")}>
          <FolderPlusIcon /> New folder
        </Button>
        <span className="ml-auto truncate text-[11px] text-muted-foreground">{toPath(path)}</span>
        <Button size="xs" onClick={() => onPick(toPath(path), name, Boolean(folder.code))}>
          {pickLabel}
        </Button>
      </div>
    </div>
  );
}
