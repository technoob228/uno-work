/**
 * The model-made hints for Home's chips: the server reads the end of a few
 * recent chats and proposes concrete follow-ups (apps/server/src/
 * homeSuggestions.ts). Cached there by chat version and here for half an hour,
 * so opening Home does not ask the model again.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";

import { environmentFetchJson } from "../../../environments/http/target";

export interface HomeSuggestionDto {
  readonly threadId: string;
  readonly label: string;
  readonly prompt: string;
}

export interface HomeSuggestionsResponse {
  readonly suggestions: ReadonlyArray<HomeSuggestionDto>;
  /** No Uno AI to ask (no key, no hours, gateway down): Home shows no chat hints. */
  readonly unavailable?: boolean;
}

export interface HomeSuggestionChat {
  readonly id: string;
  /** Changes when the chat does; part of the cache key. */
  readonly version: number;
}

export function homeSuggestionsQueryOptions(
  environmentId: EnvironmentId | null,
  chats: ReadonlyArray<HomeSuggestionChat>,
) {
  return queryOptions({
    queryKey: [
      "home-suggestions",
      environmentId,
      chats.map((chat) => `${chat.id}@${chat.version}`),
    ] as const,
    queryFn: async (): Promise<HomeSuggestionsResponse> => {
      if (!environmentId) return { suggestions: [] };
      try {
        return await environmentFetchJson<HomeSuggestionsResponse>({
          environmentId,
          pathname: "/api/home/suggestions",
          method: "POST",
          body: { threadIds: chats.map((chat) => chat.id) },
        });
      } catch {
        // An older computer has no such route; a bad moment is not worth an error.
        return { suggestions: [], unavailable: true };
      }
    },
    enabled: environmentId !== null && chats.length > 0,
    staleTime: 30 * 60_000,
    gcTime: 6 * 60 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
