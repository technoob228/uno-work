/**
 * Environment-scoped server settings.
 *
 * Server settings live on a daemon, and the app can see several daemons at
 * once. `hooks/useSettings` predates that: it reads the one global server
 * config atom and writes through `ensureLocalApi()`, both of which mean "the
 * daemon serving this page". Editing a remote environment through it reads the
 * wrong machine's providers and, worse, saves to the wrong machine's disk.
 *
 * This module is the environment-addressed counterpart. Every read and write
 * takes an explicit `environmentId`:
 *
 *   - the **primary** environment keeps using the existing global state, since
 *     that state *is* the primary daemon's config;
 *   - a **saved** environment reads the snapshot its own connection already
 *     maintains in the runtime store, and writes through that connection's
 *     `WsRpcClient`.
 *
 * Optimistic updates therefore land in per-environment state: a remote save
 * never touches the primary `serverConfigAtom`, and a failed remote save rolls
 * back only its own environment. An environment that cannot currently be
 * written to fails loudly instead of retargeting the write at primary.
 *
 * @module environments/settings/serverSettings
 */
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerConfig,
  ServerProvider,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { useCallback, useMemo } from "react";

import { ensureLocalApi } from "~/localApi";
import {
  applySettingsUpdated,
  getServerConfig,
  useServerConfig,
  whenServerConfigReady,
} from "~/rpc/serverState";

import { EnvironmentUnavailableError, isPrimaryEnvironmentId } from "../http/target";
import { readEnvironmentConnection, useSavedEnvironmentRuntimeStore } from "../runtime";
import { environmentMutationBlockMessage } from "../scope/availability";
import { useEnvironmentScope } from "../scope/scopes";

/**
 * A write was refused before it was attempted, because this environment is not
 * in a state where writes can be honoured. Distinct from a transport failure:
 * nothing was sent anywhere.
 */
export class EnvironmentMutationRefusedError extends Error {
  constructor(
    readonly environmentId: EnvironmentId,
    message: string,
  ) {
    super(message);
    this.name = "EnvironmentMutationRefusedError";
  }
}

/** The server config of one environment, or `null` before its first sync. */
export function useEnvironmentServerConfig(
  environmentId: EnvironmentId | null,
): ServerConfig | null {
  const primaryConfig = useServerConfig();
  const savedConfig = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null ? null : (state.byId[environmentId]?.serverConfig ?? null),
  );

  if (environmentId === null) return null;
  return isPrimaryEnvironmentId(environmentId) ? primaryConfig : savedConfig;
}

/** Settings of one environment, or `null` before its first sync. */
export function useEnvironmentSettings(environmentId: EnvironmentId | null): ServerSettings | null {
  return useEnvironmentServerConfig(environmentId)?.settings ?? null;
}

/** Providers configured on one environment. Empty before its first sync. */
export function useEnvironmentProviders(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ServerProvider> {
  const config = useEnvironmentServerConfig(environmentId);
  return useMemo(() => config?.providers ?? [], [config]);
}

export interface UpdateEnvironmentSettings {
  readonly updateSettings: (patch: ServerSettingsPatch) => Promise<void>;
  /** False when the UI should disable saving rather than let it fail. */
  readonly canMutate: boolean;
  /** Why saving is disabled, ready to show. `null` when it is not. */
  readonly mutationBlockedReason: string | null;
}

/**
 * An updater bound to one environment. Refuses to run when that environment
 * is not writable, so a disconnected or view-only session is reported as such
 * instead of surfacing as a transport error or a 403 after the fact.
 */
export function useUpdateEnvironmentSettings(
  environmentId: EnvironmentId | null,
): UpdateEnvironmentSettings {
  const scope = useEnvironmentScope(environmentId);
  const availability = scope?.availability ?? null;

  const updateSettings = useCallback(
    async (patch: ServerSettingsPatch): Promise<void> => {
      if (environmentId === null) {
        throw new EnvironmentUnavailableError(
          "" as EnvironmentId,
          "No environment selected for this change.",
        );
      }
      if (availability && !availability.canMutate) {
        throw new EnvironmentMutationRefusedError(
          environmentId,
          environmentMutationBlockMessage(availability.mutationBlock ?? "not-connected"),
        );
      }
      await updateEnvironmentSettings(environmentId, patch);
    },
    [availability, environmentId],
  );

  return {
    updateSettings,
    canMutate: availability?.canMutate ?? environmentId !== null,
    mutationBlockedReason:
      availability && !availability.canMutate
        ? environmentMutationBlockMessage(availability.mutationBlock ?? "not-connected")
        : null,
  };
}

/**
 * Persist a settings patch to exactly one environment, applying it optimistically
 * to that environment's state and rolling back if the daemon rejects it.
 */
export async function updateEnvironmentSettings(
  environmentId: EnvironmentId,
  patch: ServerSettingsPatch,
): Promise<void> {
  if (Object.keys(patch).length === 0) return;

  if (isPrimaryEnvironmentId(environmentId)) {
    // On a cold start the atom is still null until the RPC welcome lands;
    // without this wait the optimistic patch is silently dropped.
    const currentConfig = getServerConfig() ?? (await whenServerConfigReady());
    const previousSettings = currentConfig.settings;
    applySettingsUpdated(applyServerSettingsPatch(previousSettings, patch));
    try {
      await ensureLocalApi().server.updateSettings(patch);
    } catch (error) {
      applySettingsUpdated(previousSettings);
      throw error;
    }
    return;
  }

  const connection = readEnvironmentConnection(environmentId);
  if (!connection) {
    throw new EnvironmentUnavailableError(
      environmentId,
      "Reconnect this environment before changing its settings.",
    );
  }

  const runtime = useSavedEnvironmentRuntimeStore.getState();
  const previousConfig = runtime.byId[environmentId]?.serverConfig ?? null;
  if (previousConfig) {
    runtime.patch(environmentId, {
      serverConfig: {
        ...previousConfig,
        settings: applyServerSettingsPatch(previousConfig.settings, patch),
      },
    });
  }

  try {
    await connection.client.server.updateSettings(patch);
  } catch (error) {
    if (previousConfig) {
      useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
        serverConfig: previousConfig,
      });
    }
    throw error;
  }
}

/**
 * Ask one environment to re-probe its providers. `instanceId` narrows the
 * refresh to a single configured instance, matching the RPC.
 */
export async function refreshEnvironmentProviders(
  environmentId: EnvironmentId,
  instanceId?: ProviderInstanceId,
): Promise<void> {
  const input = instanceId === undefined ? {} : { instanceId };
  if (isPrimaryEnvironmentId(environmentId)) {
    await ensureLocalApi().server.refreshProviders(input);
    return;
  }

  const connection = readEnvironmentConnection(environmentId);
  if (!connection) {
    throw new EnvironmentUnavailableError(
      environmentId,
      "Reconnect this environment before refreshing its providers.",
    );
  }
  await connection.client.server.refreshProviders(input);
}
