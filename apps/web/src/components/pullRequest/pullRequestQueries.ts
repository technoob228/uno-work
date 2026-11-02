/** Reads and actions of the Pull requests page, through the computer that has the project. */
import type {
  EnvironmentApi,
  EnvironmentId,
  PullRequestActionInput,
  PullRequestDiffInput,
  PullRequestListInput,
  PullRequestRef,
} from "@t3tools/contracts";
import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";

import { readEnvironmentApi } from "../../environmentApi";
import { toastManager } from "../ui/toast";

const ROOT_KEY = "pull-requests";
const LIST_REFRESH_MS = 60_000;
const DETAIL_REFRESH_MS = 30_000;

export function pullRequestsApi(environmentId: string) {
  const api: EnvironmentApi["pullRequests"] = readEnvironmentApi(
    environmentId as EnvironmentId,
  )?.pullRequests;
  if (!api) throw new Error("This computer isn't connected.");
  return api;
}

export function pullRequestListQuery(environmentId: string, input: PullRequestListInput) {
  return queryOptions({
    queryKey: [ROOT_KEY, "list", environmentId, input] as const,
    queryFn: () => pullRequestsApi(environmentId).list(input),
    staleTime: 20_000,
    refetchInterval: LIST_REFRESH_MS,
    retry: false,
  });
}

export function pullRequestDetailQuery(environmentId: string, ref: PullRequestRef) {
  return queryOptions({
    queryKey: [ROOT_KEY, "detail", environmentId, ref] as const,
    queryFn: () => pullRequestsApi(environmentId).detail(ref),
    staleTime: 10_000,
    refetchInterval: DETAIL_REFRESH_MS,
    retry: false,
  });
}

export function pullRequestDiffQuery(environmentId: string, input: PullRequestDiffInput) {
  return queryOptions({
    queryKey: [ROOT_KEY, "diff", environmentId, input] as const,
    queryFn: () => pullRequestsApi(environmentId).diff(input),
    staleTime: 30_000,
    retry: false,
  });
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function usePullRequestAction(environmentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PullRequestActionInput) => pullRequestsApi(environmentId).runAction(input),
    onSettled: () => queryClient.invalidateQueries({ queryKey: [ROOT_KEY] }),
    onError: (error) =>
      toastManager.add({ type: "error", title: "Didn't go through", description: errorText(error) }),
  });
}

export function usePullRequestComment(environmentId: string, ref: PullRequestRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      pullRequestsApi(environmentId).comment({ ...ref, body: body.trim() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [ROOT_KEY, "detail"] }),
    onError: (error) =>
      toastManager.add({ type: "error", title: "Comment not sent", description: errorText(error) }),
  });
}

export function useSetFileViewed(environmentId: string, ref: PullRequestRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { readonly path: string; readonly viewed: boolean }) =>
      pullRequestsApi(environmentId).setFileViewed({ ...ref, ...input }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [ROOT_KEY, "diff"] }),
    onError: (error) =>
      toastManager.add({ type: "error", title: "Mark not saved", description: errorText(error) }),
  });
}
