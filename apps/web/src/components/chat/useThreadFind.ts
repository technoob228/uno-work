import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import { useThreadFindStore } from "../../threadFindStore";
import {
  matchAtIndex,
  startingFindIndex,
  stepThreadFindIndex,
  type ThreadFindMatch,
} from "./threadFind";

const FIND_DEBOUNCE_MS = 150;

/** Messages on screen right now, for where a new search starts. */
function readVisibleMessageIds(container: HTMLElement | null): ReadonlySet<string> {
  const visible = new Set<string>();
  if (!container) return visible;
  const viewport = container.getBoundingClientRect();
  for (const row of container.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > viewport.top && rect.top < viewport.bottom) {
      const id = row.getAttribute("data-message-id");
      if (id) visible.add(id);
    }
  }
  return visible;
}

export interface ThreadFindState {
  readonly open: boolean;
  readonly query: string;
  /** The query the matches are for: highlights follow this, not what is being typed. */
  readonly searchedQuery: string;
  readonly matchCount: number;
  readonly activeIndex: number;
  readonly match: ThreadFindMatch | null;
  /** New on every step, so stepping back to a match scrolls to it again. */
  readonly navigationId: number;
  readonly status: "loading" | "error" | null;
  readonly focusRequestId: number;
  readonly setQuery: (query: string) => void;
  readonly older: () => void;
  readonly newer: () => void;
  readonly retry: () => void;
  readonly close: () => void;
}

export function useThreadFind(input: {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Changes with the chat's messages, so counts stay right while it runs. */
  readonly revision: number;
  readonly readContainer: () => HTMLElement | null;
}): ThreadFindState {
  const { threadKey, environmentId, threadId, revision, readContainer } = input;
  const open = useThreadFindStore((store) => store.threadKey === threadKey);
  const query = useThreadFindStore((store) => (open ? store.query : ""));
  const jump = useThreadFindStore((store) => (open ? store.jump : null));
  const focusRequestId = useThreadFindStore((store) => store.focusRequestId);
  const setQuery = useThreadFindStore((store) => store.setQuery);
  const closeStore = useThreadFindStore((store) => store.close);
  const clearJump = useThreadFindStore((store) => store.clearJump);

  const trimmed = query.trim();
  const [debounced] = useDebouncedValue(trimmed, { wait: FIND_DEBOUNCE_MS });
  // A jump arrives with its query: no reason to wait.
  const searched = jump !== null ? trimmed : debounced;
  const result = useQuery({
    queryKey: ["thread-find", environmentId, threadId, searched, revision],
    enabled: open && searched.length > 0,
    queryFn: () =>
      ensureEnvironmentApi(environmentId).orchestration.findInThread({
        threadId,
        query: searched,
      }),
    placeholderData: keepPreviousData,
    staleTime: 0,
    gcTime: 30_000,
    retry: false,
  });

  const entries = useMemo(
    () => (open && searched.length > 0 ? (result.data?.entries ?? []) : []),
    [open, result.data?.entries, searched],
  );
  const matchCount = open && searched.length > 0 ? (result.data?.totalMatches ?? 0) : 0;
  const settled = !result.isPlaceholderData && result.isSuccess;

  const [position, setPosition] = useState({ query: "", index: 0, navigationId: 0 });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new search picks its first match from what is on screen, which only the DOM knows
  useEffect(() => {
    if (!open || !settled || searched.length === 0) return;
    const jumpMessageId = jump?.messageId ?? null;
    if (position.query === searched && jumpMessageId === null) return;
    setPosition((current) => ({
      query: searched,
      index: startingFindIndex(entries, {
        messageId: jumpMessageId,
        visible: readVisibleMessageIds(readContainer()),
      }),
      navigationId: current.navigationId + 1,
    }));
    if (jumpMessageId !== null) clearJump();
  }, [clearJump, entries, jump, open, position.query, readContainer, searched, settled]);

  const step = useCallback(
    (delta: number) => {
      setPosition((current) => ({
        ...current,
        index: stepThreadFindIndex(current.index, matchCount, delta),
        navigationId: current.navigationId + 1,
      }));
    },
    [matchCount],
  );

  const activeIndex = Math.min(position.index, Math.max(0, matchCount - 1));
  const typing = trimmed !== debounced && jump === null;
  return {
    open,
    query,
    searchedQuery: open ? searched : "",
    matchCount,
    activeIndex,
    match: position.query === searched ? matchAtIndex(entries, activeIndex) : null,
    navigationId: position.navigationId,
    status: result.isError ? "error" : typing || result.isFetching ? "loading" : null,
    focusRequestId,
    setQuery,
    older: useCallback(() => step(-1), [step]),
    newer: useCallback(() => step(1), [step]),
    retry: useCallback(() => void result.refetch(), [result]),
    close: closeStore,
  };
}
