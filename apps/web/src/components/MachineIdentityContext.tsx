import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { EnvironmentId } from "@t3tools/contracts";
import type { MachineIdentity } from "../machineIdentity";
import { deriveMonogram, fallbackMachineLabel } from "../machineIdentity";

/**
 * Machine chips are needed at two very different depths of the sidebar tree —
 * the project row and the chat row — and the components in between take dozens
 * of props already. This is cross-cutting display data with a single producer,
 * which is what context is for; threading it through would add a prop to every
 * layer without making anything clearer.
 */
const MachineIdentityContext = createContext<ReadonlyMap<string, MachineIdentity>>(new Map());

export function MachineIdentityProvider({
  identities,
  children,
}: {
  readonly identities: ReadonlyMap<string, MachineIdentity>;
  readonly children: ReactNode;
}) {
  return (
    <MachineIdentityContext.Provider value={identities}>{children}</MachineIdentityContext.Provider>
  );
}

/**
 * Identity for one machine, always defined.
 *
 * Falling back to a derived identity rather than returning `null` keeps callers
 * from having to render a hole: a chip whose slot has not been assigned yet is
 * neutral and still carries a monogram, which is exactly the intended
 * degradation.
 */
export function useMachineIdentity(environmentId: EnvironmentId): MachineIdentity {
  const identities = useContext(MachineIdentityContext);
  return useMemo(() => {
    const existing = identities.get(environmentId);
    if (existing !== undefined) {
      return existing;
    }
    const label = fallbackMachineLabel(environmentId);
    return {
      environmentId,
      monogram: deriveMonogram(label),
      colorSlot: 0,
      label,
      isMonogramOverridden: false,
    };
  }, [environmentId, identities]);
}

export function useMachineIdentities(
  environmentIds: readonly EnvironmentId[],
): readonly MachineIdentity[] {
  const identities = useContext(MachineIdentityContext);
  return useMemo(
    () =>
      environmentIds.flatMap((environmentId) => {
        const identity = identities.get(environmentId);
        return identity === undefined ? [] : [identity];
      }),
    [environmentIds, identities],
  );
}
