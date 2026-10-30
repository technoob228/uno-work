import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { formatThreadFindCount } from "./threadFind";

interface ThreadFindBarProps {
  readonly query: string;
  readonly matchCount: number;
  readonly activeIndex: number;
  readonly status: "loading" | "error" | null;
  readonly focusRequestId: number;
  readonly onQueryChange: (query: string) => void;
  /** Back in time, up the chat. */
  readonly onOlder: () => void;
  /** Forward in time, down the chat. */
  readonly onNewer: () => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}

export function ThreadFindBar(props: ThreadFindBarProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Each ⌘F bumps the id, so an open bar takes the keyboard back and selects.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [props.focusRequestId]);

  const hasQuery = props.query.trim().length > 0;
  const noResults = hasQuery && props.status === null && props.matchCount === 0;
  const navigationDisabled = props.matchCount === 0 || props.status === "error";
  const label = !hasQuery
    ? ""
    : props.status === "error"
      ? "Search failed"
      : props.status === "loading"
        ? "…"
        : formatThreadFindCount(props.activeIndex, props.matchCount);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) props.onNewer();
      else props.onOlder();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
    }
  };

  return (
    <div
      data-thread-find-bar
      role="search"
      aria-label="Find in chat"
      aria-busy={props.status === "loading"}
      className="absolute top-3 right-3 z-40 flex h-9 w-[min(24rem,calc(100%-1.5rem))] items-center gap-1 rounded-lg border border-border bg-popover pr-1 pl-3 shadow-md"
    >
      <input
        ref={inputRef}
        type="text"
        value={props.query}
        aria-label="Find in chat"
        placeholder="Find in chat"
        maxLength={200}
        spellCheck={false}
        autoComplete="off"
        data-testid="thread-find-input"
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        onChange={(event) => props.onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span
        aria-live="polite"
        className={cn(
          "min-w-9 text-center text-xs tabular-nums",
          noResults || props.status === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      {props.status === "error" ? (
        <Button size="xs" variant="ghost" onClick={props.onRetry}>
          Retry
        </Button>
      ) : null}
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Previous match"
        disabled={navigationDisabled}
        onClick={props.onOlder}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Next match"
        disabled={navigationDisabled}
        onClick={props.onNewer}
      >
        <ChevronDownIcon />
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Close find" onClick={props.onClose}>
        <XIcon />
      </Button>
    </div>
  );
}
