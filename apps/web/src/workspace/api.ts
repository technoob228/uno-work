/**
 * The workspace from the account (proposed API, 10.11): one read and a few
 * verbs. Work shows only what this API has — nothing on these screens is
 * Work's own state (Misha: "in Work there's nothing that isn't in the API").
 *
 *   GET  /api/v1/workspace                              → Workspace
 *   POST /api/v1/workspace/computers/{id}/wake
 *   POST /api/v1/workspace/computers/{id}/welcome        { assistants: string[] }
 *   PUT  /api/v1/workspace/assistants/{id}               { hands, wakes }
 *   POST /api/v1/workspace/apps/{id}/open                → { url } (wakes what it needs)
 *   POST /api/v1/workspace/apps/{id}/move                { to }
 *   PUT  /api/v1/workspace/chats/{threadId}              { computer } (where the next turn runs)
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { accountRequest } from "../account/unoAccount";
import type { Workspace } from "./model";

export const workspaceKey = ["workspace", "vision"] as const;

export const workspaceQuery = () =>
  queryOptions({
    queryKey: workspaceKey,
    queryFn: async () => (await accountRequest("GET", "/api/v1/workspace")) as Workspace,
    // A computer waking or a new one joining shows up without a reload.
    refetchInterval: (query) =>
      query.state.data?.computers.some((computer) => computer.state === "waking") ? 700 : 4000,
    staleTime: 500,
  });

export function useWorkspace() {
  return useQuery(workspaceQuery());
}

function useWorkspaceMutation<T, R = unknown>(run: (input: T) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSettled: () => client.invalidateQueries({ queryKey: workspaceKey }),
  });
}

export const useWake = () =>
  useWorkspaceMutation((id: string) =>
    accountRequest("POST", `/api/v1/workspace/computers/${encodeURIComponent(id)}/wake`),
  );

export const useWelcomeComputer = () =>
  useWorkspaceMutation((input: { id: string; assistants: ReadonlyArray<string> }) =>
    accountRequest("POST", `/api/v1/workspace/computers/${encodeURIComponent(input.id)}/welcome`, {
      assistants: input.assistants,
    }),
  );

export const useSetHands = () =>
  useWorkspaceMutation((input: { id: string; hands: ReadonlyArray<string>; wakes: boolean }) =>
    accountRequest("PUT", `/api/v1/workspace/assistants/${encodeURIComponent(input.id)}`, {
      hands: input.hands,
      wakes: input.wakes,
    }),
  );

export const useOpenApp = () =>
  useWorkspaceMutation(
    async (id: string) =>
      (await accountRequest("POST", `/api/v1/workspace/apps/${encodeURIComponent(id)}/open`)) as {
        url: string;
      },
  );

export const useMoveApp = () =>
  useWorkspaceMutation((input: { id: string; to: string }) =>
    accountRequest("POST", `/api/v1/workspace/apps/${encodeURIComponent(input.id)}/move`, {
      to: input.to,
    }),
  );

/** Where a chat's next turn runs (null: its own computer). */
export function chatComputerQuery(threadId: string) {
  return queryOptions({
    queryKey: [...workspaceKey, "chat", threadId],
    queryFn: async () =>
      ((await accountRequest("GET", `/api/v1/workspace/chats/${encodeURIComponent(threadId)}`)) as {
        computer: string | null;
      }) ?? { computer: null },
  });
}

export function useSetChatComputer(threadId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (computer: string | null) =>
      accountRequest("PUT", `/api/v1/workspace/chats/${encodeURIComponent(threadId)}`, {
        computer,
      }),
    onSuccess: (_result, computer) =>
      client.setQueryData([...workspaceKey, "chat", threadId], { computer }),
  });
}
