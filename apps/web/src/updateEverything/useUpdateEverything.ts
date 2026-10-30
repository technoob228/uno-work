/**
 * The live half of "Update everything": the person's computers from the shared
 * machine list, what each one says about itself, and the calls that run the plan.
 */
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import type { AgentUpdateStatus } from "@t3tools/shared/agentVersions";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { resolveClient } from "../components/harness/useHarnessSetup";
import { isElectron } from "../env";
import { ensureEnvironmentConnectionBootstrapped } from "../environments/runtime";
import { refreshEnvironmentProviders } from "../environments/settings/serverSettings";
import { useMachineRows } from "../hooks/useMachineRows";
import { usePrimaryEnvironmentId } from "../environments/primary/context";
import {
  setDesktopUpdateStateQueryData,
  useDesktopUpdateState,
} from "../lib/desktopUpdateReactQuery";
import { resolveDesktopUpdateButtonAction } from "../components/desktopUpdate.logic";
import {
  agentUpdatesQueryOptions,
  fetchAgentUpdates,
  fetchSelfUpdateStatus,
  requestSelfUpdate,
  selfUpdateQueryKey,
  selfUpdateQueryOptions,
  type SelfUpdateWhen,
} from "../selfUpdate/selfUpdate";
import { useStore } from "../store";
import { connectUnoBoxById, isBoxDead } from "../unoBoxConnect";
import {
  buildUpdatePlan,
  type PlanRow,
  type RunDeps,
  type UpdateTarget,
} from "./updateEverything.logic";

const POLL_MS = 2_000;
/** The updater's own limit is 30 min; two minutes is usual. */
const WORK_TIMEOUT_MS = 12 * 60_000;
const AGENT_TIMEOUT_MS = 10 * 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForAgentJob(environmentId: EnvironmentId, agent: AgentUpdateStatus) {
  const client = resolveClient(environmentId);
  const driver = agent.driver as ProviderDriverKind;
  const { jobId } = await client.providerSetup.installStart({ driver });
  const deadline = Date.now() + AGENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const status = await client.providerSetup.installStatus({ jobId });
    if (status.state === "succeeded") {
      void refreshEnvironmentProviders(environmentId, defaultInstanceIdForDriver(driver));
      return;
    }
    if (status.state === "failed") throw new Error(status.error ?? "The install didn't finish.");
  }
  throw new Error("The install took too long.");
}

async function waitForWorkUpdate(
  environmentId: EnvironmentId,
  when: SelfUpdateWhen,
): Promise<"updated" | "waiting"> {
  const started = await requestSelfUpdate(environmentId, when);
  // Held for its agents: the computer goes on by itself, and tells so in its
  // own notice. Nobody has to keep this window open for half an hour.
  if (started.waiting) return "waiting";
  const deadline = Date.now() + WORK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    // The daemon restarts on the way: a failed read is part of the update.
    const status = await fetchSelfUpdateStatus(environmentId).catch(() => null);
    if (status?.state === "done") return "updated";
    if (status?.state === "failed") throw new Error(status.error ?? "The update didn't finish.");
  }
  throw new Error("The update took too long. It may still finish by itself.");
}

export function useUpdateEverything() {
  const queryClient = useQueryClient();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const machines = useMachineRows();
  const desktop = useDesktopUpdateState().data ?? null;
  const threadsByEnvironment = useStore((state) => state.environmentStateById);

  const online = useMemo(
    () =>
      machines.filter(
        (row): row is typeof row & { environmentId: EnvironmentId } =>
          row.environmentId !== null && (row.isPrimary || row.status === "online"),
      ),
    [machines],
  );
  const selfUpdates = useQueries({
    queries: online.map((row) => selfUpdateQueryOptions(row.environmentId)),
  });
  const agentUpdates = useQueries({
    queries: online.map((row) => agentUpdatesQueryOptions(row.environmentId)),
  });

  // Mounted with the dialog: how many agents work now, not a minute ago.
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ["self-update"] });
  }, [queryClient]);

  const rows = useMemo<ReadonlyArray<PlanRow>>(() => {
    const targets = machines.flatMap((row): UpdateTarget[] => {
      if (row.box && isBoxDead(row.box.status)) return [];
      const index = online.findIndex((entry) => entry.key === row.key);
      const isOnline = index >= 0;
      const environmentId = row.environmentId;
      const state = environmentId ? threadsByEnvironment[environmentId] : undefined;
      const runningChats = state
        ? Object.values(state.threadSessionById).filter(
            (session) => session?.orchestrationStatus === "running",
          ).length
        : 0;
      return [
        {
          key: row.key,
          label: row.label,
          environmentId,
          boxId: row.box?.id ?? null,
          isPrimary: row.isPrimary,
          reach: isOnline ? "online" : row.box ? "asleep" : "offline",
          selfUpdate: isOnline ? selfUpdates[index]?.data : null,
          agents: isOnline ? agentUpdates[index]?.data : null,
          runningChats,
        },
      ];
    });
    return buildUpdatePlan(targets);
  }, [agentUpdates, machines, online, selfUpdates, threadsByEnvironment]);

  const appAction = isElectron && desktop ? resolveDesktopUpdateButtonAction(desktop) : "none";
  const appVersion = desktop?.downloadedVersion ?? desktop?.availableVersion ?? null;

  const runDeps: Omit<RunDeps, "onProgress" | "updateWork"> & {
    readonly updateWork: (
      environmentId: string,
      when: SelfUpdateWhen,
    ) => ReturnType<RunDeps["updateWork"]>;
  } = {
    wake: async (row) => {
      if (row.boxId === null || primaryEnvironmentId === null) {
        throw new Error("Couldn't reach this computer.");
      }
      const record = await connectUnoBoxById(primaryEnvironmentId, row.boxId, row.label);
      const environmentId = record.environmentId;
      await ensureEnvironmentConnectionBootstrapped(environmentId);
      const [self, agents] = await Promise.all([
        fetchSelfUpdateStatus(environmentId),
        fetchAgentUpdates(environmentId).catch(() => null),
      ]);
      return {
        environmentId,
        work: self?.available && self.canUpdate ? self.latestVersion : null,
        agents: agents?.filter((agent) => agent.behind) ?? [],
      };
    },
    updateAgent: (environmentId, agent) => waitForAgentJob(environmentId as EnvironmentId, agent),
    updateWork: async (environmentId, when) => {
      const id = environmentId as EnvironmentId;
      try {
        return await waitForWorkUpdate(id, when);
      } finally {
        // The notice on that computer: "waiting", "updating", or the error.
        void queryClient.invalidateQueries({ queryKey: selfUpdateQueryKey(id) });
      }
    },
  };

  /** Downloads this app's update and restarts into it: the very last step. */
  const updateApp = async () => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktop) return;
    if (resolveDesktopUpdateButtonAction(desktop) === "download") {
      const result = await bridge.downloadUpdate();
      setDesktopUpdateStateQueryData(queryClient, result.state);
      if (!result.completed) throw new Error("The download didn't finish.");
    }
    const installed = await bridge.installUpdate();
    setDesktopUpdateStateQueryData(queryClient, installed.state);
  };

  return {
    rows,
    app: appAction === "none" ? null : { version: appVersion },
    runDeps,
    updateApp,
    checking: selfUpdates.some((query) => query.isPending),
  };
}
