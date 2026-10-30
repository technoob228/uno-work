import type {
  EnvironmentId,
  OrchestrationSearchThreadsResult,
  OrchestrationThreadSearchMatch,
} from "@t3tools/contracts";
import { messageSearchTokens } from "@t3tools/shared/threadSearch";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { readEnvironmentApi } from "../environmentApi";

const SEARCH_DEBOUNCE_MS = 180;
const EMPTY_RESULT: OrchestrationSearchThreadsResult = { matches: [], indexing: false };

export interface EnvironmentMessageMatch extends OrchestrationThreadSearchMatch {
  readonly environmentId: EnvironmentId;
}

/** Best matches first across computers: whole words, then the newest. */
export function mergeMessageMatches(
  results: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly matches: ReadonlyArray<OrchestrationThreadSearchMatch>;
  }>,
): EnvironmentMessageMatch[] {
  return results
    .flatMap(({ environmentId, matches }) => matches.map((match) => ({ ...match, environmentId })))
    .toSorted(
      (left, right) =>
        right.quality - left.quality ||
        right.messageCreatedAt.localeCompare(left.messageCreatedAt) ||
        right.hits - left.hits,
    );
}

/**
 * Asks every computer for messages matching `query`. Each answers on its own,
 * so one that is slow or asleep does not hold the others; one on an older
 * version just has nothing to add.
 */
export function useMessageSearch(input: {
  readonly query: string;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly enabled: boolean;
}): {
  readonly query: string;
  readonly matches: ReadonlyArray<EnvironmentMessageMatch>;
  readonly searching: boolean;
  readonly indexing: boolean;
} {
  const trimmed = input.query.trim();
  const [debounced] = useDebouncedValue(trimmed, { wait: SEARCH_DEBOUNCE_MS });
  const searchable =
    input.enabled && debounced.length >= 2 && messageSearchTokens(debounced).long.length > 0;

  const results = useQueries({
    queries: input.environmentIds.map((environmentId) => ({
      queryKey: ["message-search", environmentId, debounced],
      enabled: searchable,
      queryFn: async () =>
        (await readEnvironmentApi(environmentId)?.orchestration.searchThreads({
          query: debounced,
          limit: 10,
        })) ?? EMPTY_RESULT,
      staleTime: 5_000,
      gcTime: 30_000,
      retry: false,
      placeholderData: keepPreviousData,
    })),
  });

  const answers = results.map((result) => result.data);
  const matches = useMemo(
    () =>
      searchable
        ? mergeMessageMatches(
            answers.flatMap((answer, index) => {
              const environmentId = input.environmentIds[index];
              return answer && environmentId ? [{ environmentId, matches: answer.matches }] : [];
            }),
          )
        : [],
    // `results` is a new array on every render; its data keeps identity between fetches.
    // oxlint-disable-next-line react/exhaustive-deps
    [searchable, input.environmentIds, ...answers],
  );

  return {
    query: debounced,
    matches,
    searching: searchable && results.some((result) => result.isFetching),
    indexing: searchable && answers.some((answer) => answer?.indexing === true),
  };
}
