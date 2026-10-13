/**
 * Back / forward / up in Files (Misha 13.10): the path in the header got
 * squeezed on a narrow window and could not be clicked, so the way out of a
 * folder is a set of arrows. Back and forward walk the places visited inside
 * Files only (never out of the page); up goes to the folder above.
 */
import { ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../ui/button";
import type { FilesRouteSearch } from "./filesRouteSearch";

interface Stack {
  readonly entries: ReadonlyArray<string>;
  readonly index: number;
}

export interface FilesHistory {
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly back: () => void;
  readonly forward: () => void;
}

/** The place a search stands for, folder or file, as one comparable string. */
export function filesPlaceKey(search: FilesRouteSearch): string {
  return JSON.stringify({
    cloud: search.cloud ?? null,
    bucket: search.bucket ?? null,
    prefix: search.prefix ?? null,
    path: search.path ?? null,
    file: search.file ?? null,
  });
}

/** Pure step of the stack: a new place after the current one drops the forward part. */
export function visitPlace(stack: Stack, key: string): Stack {
  if (stack.entries[stack.index] === key) return stack;
  const entries = [...stack.entries.slice(0, stack.index + 1), key].slice(-100);
  return { entries, index: entries.length - 1 };
}

export function useFilesHistory(
  search: FilesRouteSearch,
  go: (search: FilesRouteSearch) => void,
): FilesHistory {
  const [stack, setStack] = useState<Stack>({ entries: [], index: -1 });
  const key = filesPlaceKey(search);
  useEffect(() => setStack((current) => visitPlace(current, key)), [key]);

  const step = useCallback(
    (delta: -1 | 1) => {
      const target = stack.entries[stack.index + delta];
      if (target === undefined) return;
      const place = JSON.parse(target) as Record<string, string | number | null>;
      const next: { -readonly [K in keyof FilesRouteSearch]: FilesRouteSearch[K] } = {};
      if (place["cloud"] === "1") next.cloud = "1";
      if (typeof place["bucket"] === "number") next.bucket = place["bucket"];
      if (typeof place["prefix"] === "string") next.prefix = place["prefix"];
      if (typeof place["path"] === "string") next.path = place["path"];
      if (typeof place["file"] === "string") next.file = place["file"];
      // Land on the place in the stack, not on a new entry after it.
      setStack({ entries: stack.entries, index: stack.index + delta });
      go(next);
    },
    [go, stack],
  );

  return {
    canBack: stack.index > 0,
    canForward: stack.index >= 0 && stack.index < stack.entries.length - 1,
    back: () => step(-1),
    forward: () => step(1),
  };
}

/** ← → ↑ for a header; `onUp` is null at the top of the home folder, undefined where there is no ↑. */
export function FilesNavButtons({
  history,
  onUp,
}: {
  history: FilesHistory;
  onUp?: (() => void) | null;
}) {
  return (
    <div className="flex shrink-0 items-center" data-testid="files-nav">
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Back"
        title="Back"
        disabled={!history.canBack}
        onClick={history.back}
      >
        <ArrowLeftIcon />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Forward"
        title="Forward"
        disabled={!history.canForward}
        onClick={history.forward}
      >
        <ArrowRightIcon />
      </Button>
      {onUp === undefined ? null : (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Up one folder"
          title="Up one folder"
          disabled={onUp === null}
          onClick={() => onUp?.()}
        >
          <ArrowUpIcon />
        </Button>
      )}
    </div>
  );
}
