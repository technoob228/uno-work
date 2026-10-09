/**
 * What staleBundle.ts needs to know about a machine, read from the stores at
 * the moment of a switch (no subscription: the switch is a single decision).
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { readPrimaryEnvironmentDescriptor } from "./environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "./environments/runtime";
import type { StaleBundleMachine } from "./staleBundle";

export function readStaleBundleMachine(environmentId: EnvironmentId): StaleBundleMachine {
  const primary = readPrimaryEnvironmentDescriptor();
  if (primary && primary.environmentId === environmentId) {
    return {
      isPrimary: true,
      unoBoxId: primary.unoBoxId ?? null,
      serverVersion: primary.serverVersion,
    };
  }
  const record = useSavedEnvironmentRegistryStore.getState().byId[environmentId];
  const runtime = useSavedEnvironmentRuntimeStore.getState().byId[environmentId];
  return {
    isPrimary: false,
    unoBoxId: record?.unoBoxId ?? runtime?.descriptor?.unoBoxId ?? null,
    serverVersion:
      runtime?.serverConfig?.environment.serverVersion ??
      runtime?.descriptor?.serverVersion ??
      null,
  };
}
