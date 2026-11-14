/**
 * Whether a chat holds a stranger's text as the daemon keeps it
 * (`apps/server/src/automations/outsideThreads.ts`): a site form's or a
 * webhook's text that came in Ask mode, or a Telegram group member's. While it
 * does, the chat's Uno Work tools ask first. The person lifts it with "Trust
 * this chat" (`POST /api/manager/threads/:id/trust-outside`, their own
 * session only).
 *
 * An older daemon answers 404: nothing to show.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { environmentFetchJson } from "~/environments/http/target";

interface OutsideTextState {
  readonly holdsOutsideText: boolean;
}

const threadPath = (threadId: string, leaf: string) =>
  `/api/manager/threads/${encodeURIComponent(threadId)}/${leaf}`;

export function readChatOutsideText(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
}): Promise<OutsideTextState> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: threadPath(input.threadId, "outside-text"),
  });
}

export function trustChatOutsideText(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
}): Promise<OutsideTextState> {
  return environmentFetchJson({
    environmentId: input.environmentId,
    pathname: threadPath(input.threadId, "trust-outside"),
    method: "POST",
  });
}

export const chatOutsideTextQueryKey = (environmentId: EnvironmentId | null, threadId: string) =>
  ["chat-outside-text", environmentId, threadId] as const;

/**
 * True while the daemon has the chat marked. `revision` (the chat's message
 * count) asks again when something new lands: a form's run marks the chat as
 * it starts.
 */
export function useChatOutsideText(
  environmentId: EnvironmentId | null,
  threadId: string | null,
  revision: number,
): boolean {
  const query = useQuery({
    queryKey: [...chatOutsideTextQueryKey(environmentId, threadId ?? ""), revision] as const,
    queryFn: () => readChatOutsideText({ environmentId: environmentId!, threadId: threadId! }),
    enabled: environmentId !== null && threadId !== null,
    // A new message keeps the last answer while it asks; another chat doesn't.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === environmentId && previousQuery.queryKey[2] === threadId
        ? previous
        : undefined,
    staleTime: 30_000,
    retry: false,
  });
  return query.data?.holdsOutsideText === true;
}
