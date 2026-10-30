import type { EnvironmentId, ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

import { usePrimaryEnvironmentDescriptor } from "./primary";
import { useSavedEnvironmentRuntimeStore } from "./runtime";

/**
 * Whether the daemon behind `environmentId` reads the person's Claude and
 * ChatGPT plan limits (`uno.computer.planLimits`, 0.0.157). Older daemons
 * don't advertise `planLimits`: Home doesn't offer the widget for them.
 */
export function descriptorSupportsPlanLimits(
  descriptor: ExecutionEnvironmentDescriptor | null | undefined,
): boolean {
  return descriptor?.capabilities.planLimits === true;
}

export function useEnvironmentSupportsPlanLimits(
  environmentId: EnvironmentId | null | undefined,
): boolean {
  const primary = usePrimaryEnvironmentDescriptor();
  const saved = useSavedEnvironmentRuntimeStore((state) =>
    environmentId ? descriptorSupportsPlanLimits(state.byId[environmentId]?.descriptor) : false,
  );
  if (!environmentId) return false;
  if (primary?.environmentId === environmentId) return descriptorSupportsPlanLimits(primary);
  return saved;
}

/**
 * What the daemon behind `environmentId` advertises for the person's AI plans:
 * a chat going on after the reset, second accounts. Older daemons have neither
 * and Settings doesn't offer them for that computer.
 */
export function useEnvironmentPlanFeatures(environmentId: EnvironmentId | null | undefined): {
  readonly planResume: boolean;
  readonly providerAccounts: boolean;
} {
  const primary = usePrimaryEnvironmentDescriptor();
  const saved = useSavedEnvironmentRuntimeStore((state) =>
    environmentId ? (state.byId[environmentId]?.descriptor ?? null) : null,
  );
  const descriptor = primary?.environmentId === environmentId ? primary : saved;
  return {
    planResume: descriptor?.capabilities.planResume === true,
    providerAccounts: descriptor?.capabilities.providerAccounts === true,
  };
}
