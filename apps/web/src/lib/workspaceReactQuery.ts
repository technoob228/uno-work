/**
 * Query and mutation options for the workspace registry and the Uno account
 * behind it.
 *
 * Everything is keyed by the *registry* environment rather than the active one:
 * the panel shows one workspace no matter which machine's chat you happen to be
 * looking at, and keying by the active environment would make it flicker
 * between two registries as you move around the sidebar.
 */
import type {
  EnvironmentId,
  UnoBoxConnection,
  UnoCloudBoxPowerInput,
  UnoCloudConnectBoxInput,
  WorkspaceAcquireClaimInput,
  WorkspaceApplyInstructionsInput,
  WorkspaceCreateRequestInput,
  WorkspaceDecideRequestInput,
  WorkspaceGetInstructionsInput,
  WorkspaceReleaseClaimInput,
  WorkspaceRenameInput,
  WorkspaceRemoveGrantInput,
  WorkspaceRemoveMachineInput,
  WorkspaceSetInstructionsInput,
  WorkspaceSetPolicyInput,
  WorkspaceSyncMachinesInput,
  WorkspaceUpdateMachineInput,
  WorkspaceUpsertGrantInput,
} from "@t3tools/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { ensureEnvironmentApi } from "../environmentApi";

const WORKSPACE_STALE_TIME_MS = 5_000;
/**
 * Claims expire and boxes wake on their own, so the panel polls. Ten seconds is
 * slow enough to be invisible in CPU terms and fast enough that "who holds this
 * claim" is never meaningfully wrong while you are looking at it.
 */
const WORKSPACE_REFETCH_INTERVAL_MS = 10_000;
const UNO_CLOUD_STALE_TIME_MS = 15_000;
const UNO_CLOUD_REFETCH_INTERVAL_MS = 30_000;

export const workspaceQueryKeys = {
  all: ["workspace"] as const,
  state: (environmentId: EnvironmentId | null) => ["workspace", "state", environmentId] as const,
  instructions: (
    environmentId: EnvironmentId | null,
    target: EnvironmentId | null,
    cwd: string | null,
  ) => ["workspace", "instructions", environmentId, target, cwd] as const,
  unoCloud: (environmentId: EnvironmentId | null) =>
    ["workspace", "uno-cloud", environmentId] as const,
};

export function invalidateWorkspaceQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all });
}

export function workspaceStateQueryOptions(environmentId: EnvironmentId | null) {
  return queryOptions({
    queryKey: workspaceQueryKeys.state(environmentId),
    queryFn: () => {
      if (environmentId === null) throw new Error("No environment connection for the workspace.");
      return ensureEnvironmentApi(environmentId).workspace.getState();
    },
    enabled: environmentId !== null,
    staleTime: WORKSPACE_STALE_TIME_MS,
    refetchInterval: WORKSPACE_REFETCH_INTERVAL_MS,
  });
}

export function unoCloudStateQueryOptions(environmentId: EnvironmentId | null) {
  return queryOptions({
    queryKey: workspaceQueryKeys.unoCloud(environmentId),
    queryFn: () => {
      if (environmentId === null) throw new Error("No environment connection for the Uno account.");
      return ensureEnvironmentApi(environmentId).unoCloud.getState();
    },
    enabled: environmentId !== null,
    staleTime: UNO_CLOUD_STALE_TIME_MS,
    refetchInterval: UNO_CLOUD_REFETCH_INTERVAL_MS,
  });
}

export function workspaceInstructionsQueryOptions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly targetEnvironmentId: EnvironmentId | null;
  readonly projectPath: string | null;
}) {
  return queryOptions({
    queryKey: workspaceQueryKeys.instructions(
      input.environmentId,
      input.targetEnvironmentId,
      input.projectPath,
    ),
    queryFn: () => {
      if (input.environmentId === null || input.targetEnvironmentId === null) {
        throw new Error("No environment selected for instructions.");
      }
      const payload: WorkspaceGetInstructionsInput = {
        environmentId: input.targetEnvironmentId,
        ...(input.projectPath ? { projectPath: input.projectPath } : {}),
      };
      return ensureEnvironmentApi(input.environmentId).workspace.getInstructions(payload);
    },
    enabled: input.environmentId !== null && input.targetEnvironmentId !== null,
    staleTime: WORKSPACE_STALE_TIME_MS,
  });
}

/**
 * All mutations write the returned state straight into the cache. The server
 * answers with the full snapshot, so this is not an optimistic guess — it is
 * the authoritative epoch, and skipping the refetch keeps a click from
 * flickering the panel.
 */
function makeWorkspaceMutation<TInput>(input: {
  readonly environmentId: EnvironmentId | null;
  readonly queryClient: QueryClient;
  readonly key: string;
  readonly run: (api: ReturnType<typeof ensureEnvironmentApi>, payload: TInput) => Promise<unknown>;
}) {
  return mutationOptions({
    mutationKey: ["workspace", "mutation", input.key, input.environmentId] as const,
    mutationFn: async (payload: TInput) => {
      if (input.environmentId === null) throw new Error("No environment connection.");
      return input.run(ensureEnvironmentApi(input.environmentId), payload);
    },
    onSuccess: (result) => {
      if (result && typeof result === "object" && "identity" in result) {
        input.queryClient.setQueryData(workspaceQueryKeys.state(input.environmentId), result);
      }
    },
  });
}

export function workspaceRenameMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return makeWorkspaceMutation<WorkspaceRenameInput>({
    environmentId,
    queryClient,
    key: "rename",
    run: (api, payload) => api.workspace.rename(payload),
  });
}

export function workspaceSyncMachinesMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return makeWorkspaceMutation<WorkspaceSyncMachinesInput>({
    environmentId,
    queryClient,
    key: "sync-machines",
    run: (api, payload) => api.workspace.syncMachines(payload),
  });
}

export function workspaceUpdateMachineMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return makeWorkspaceMutation<WorkspaceUpdateMachineInput>({
    environmentId,
    queryClient,
    key: "update-machine",
    run: (api, payload) => api.workspace.updateMachine(payload),
  });
}

export function workspaceRemoveMachineMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return makeWorkspaceMutation<WorkspaceRemoveMachineInput>({
    environmentId,
    queryClient,
    key: "remove-machine",
    run: (api, payload) => api.workspace.removeMachine(payload),
  });
}

export function workspaceSetPolicyMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return makeWorkspaceMutation<WorkspaceSetPolicyInput>({
    environmentId,
    queryClient,
    key: "set-policy",
    run: (api, payload) => api.workspace.setPolicy(payload),
  });
}

export function workspaceUpsertGrantMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return makeWorkspaceMutation<WorkspaceUpsertGrantInput>({
    environmentId,
    queryClient,
    key: "upsert-grant",
    run: (api, payload) => api.workspace.upsertGrant(payload),
  });
}

export function workspaceRemoveGrantMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return makeWorkspaceMutation<WorkspaceRemoveGrantInput>({
    environmentId,
    queryClient,
    key: "remove-grant",
    run: (api, payload) => api.workspace.removeGrant(payload),
  });
}

export function workspaceReleaseClaimMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return makeWorkspaceMutation<WorkspaceReleaseClaimInput>({
    environmentId,
    queryClient,
    key: "release-claim",
    run: (api, payload) => api.workspace.releaseClaim(payload),
  });
}

export function workspaceAcquireClaimMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationKey: ["workspace", "mutation", "acquire-claim", environmentId] as const,
    mutationFn: async (payload: WorkspaceAcquireClaimInput) => {
      if (environmentId === null) throw new Error("No environment connection.");
      return ensureEnvironmentApi(environmentId).workspace.acquireClaim(payload);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(workspaceQueryKeys.state(environmentId), result.state);
    },
  });
}

export function workspaceCreateRequestMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationKey: ["workspace", "mutation", "create-request", environmentId] as const,
    mutationFn: async (payload: WorkspaceCreateRequestInput) => {
      if (environmentId === null) throw new Error("No environment connection.");
      return ensureEnvironmentApi(environmentId).workspace.createRequest(payload);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(workspaceQueryKeys.state(environmentId), result.state);
    },
  });
}

export function workspaceDecideRequestMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return makeWorkspaceMutation<WorkspaceDecideRequestInput>({
    environmentId,
    queryClient,
    key: "decide-request",
    run: (api, payload) => api.workspace.decideRequest(payload),
  });
}

export function workspaceSetInstructionsMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationKey: ["workspace", "mutation", "set-instructions", environmentId] as const,
    mutationFn: async (payload: WorkspaceSetInstructionsInput) => {
      if (environmentId === null) throw new Error("No environment connection.");
      return ensureEnvironmentApi(environmentId).workspace.setInstructions(payload);
    },
    onSuccess: async (result) => {
      queryClient.setQueryData(workspaceQueryKeys.state(environmentId), result);
      await queryClient.invalidateQueries({
        queryKey: ["workspace", "instructions"] as const,
      });
    },
  });
}

export function workspaceApplyInstructionsMutationOptions(environmentId: EnvironmentId | null) {
  return mutationOptions({
    mutationKey: ["workspace", "mutation", "apply-instructions", environmentId] as const,
    mutationFn: async (payload: WorkspaceApplyInstructionsInput) => {
      if (environmentId === null) throw new Error("No environment connection.");
      return ensureEnvironmentApi(environmentId).workspace.applyInstructions(payload);
    },
  });
}

export function unoCloudBoxPowerMutationOptions(
  environmentId: EnvironmentId | null,
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationKey: ["workspace", "mutation", "box-power", environmentId] as const,
    mutationFn: async (payload: UnoCloudBoxPowerInput) => {
      if (environmentId === null) throw new Error("No environment connection.");
      return ensureEnvironmentApi(environmentId).unoCloud.boxPower(payload);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(workspaceQueryKeys.unoCloud(environmentId), result);
    },
  });
}

export function unoCloudConnectBoxMutationOptions(environmentId: EnvironmentId | null) {
  return mutationOptions({
    mutationKey: ["workspace", "mutation", "connect-box", environmentId] as const,
    mutationFn: async (payload: UnoCloudConnectBoxInput): Promise<UnoBoxConnection> => {
      if (environmentId === null) throw new Error("No environment connection.");
      return ensureEnvironmentApi(environmentId).unoCloud.connectBox(payload);
    },
  });
}
